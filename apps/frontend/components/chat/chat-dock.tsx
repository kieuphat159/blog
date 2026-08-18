"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { io, Socket } from "socket.io-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChatBubbleLeftRightIcon, XMarkIcon } from "@heroicons/react/24/outline";

import { BACKEND_URL } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Session } from "@/lib/session";
import {
  ChatConversation,
  ChatMessage,
  createDirectConversation,
  fetchConversations,
  fetchFriends,
  fetchMessages,
  markConversationRead,
} from "@/lib/chat";
import ChatSidebar from "./chat-sidebar";
import ChatThread from "./chat-thread";
import {
  redirectToSignOut,
  shouldSignOutFromError,
  type ChatCallState,
  type SidebarTab,
} from "./chat-utils";

type SocketMessage = ChatMessage;
type OutgoingMessage = {
  content: string;
  conversationId: number;
  tempId: string;
};

type Props = {
  session: Session | null;
};

type SocketState = "idle" | "connecting" | "connected";

async function waitForSocketConnection(socket: Socket, timeoutMs = 15_000) {
  if (socket.connected) {
    return;
  }

  let lastError: Error | null = null;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", handleConnect);
      socket.off("connect_error", handleError);
    };

    const handleConnect = () => {
      cleanup();
      resolve();
    };

    const handleError = (error: Error) => {
      lastError = error;
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(lastError ?? new Error("Socket connection timeout"));
    }, timeoutMs);

    socket.on("connect", handleConnect);
    socket.on("connect_error", handleError);
    socket.connect();
  });
}

export default function ChatDock({ session }: Props) {
  const queryClient = useQueryClient();
  const socketRef = useRef<Socket | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeConversationRef = useRef<number | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const pendingCallRef = useRef<{ conversationId: number; targetUserId: number } | null>(null);
  const queuedIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const iceServersPromiseRef = useRef<Promise<RTCIceServer[]> | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [selectedConversationId, setSelectedConversationId] = useState<number | null>(null);
  const [messageDraft, setMessageDraft] = useState("");
  const [activeTab, setActiveTab] = useState<SidebarTab>("chats");
  const [friendFilter, setFriendFilter] = useState("");
  const [socketState, setSocketState] = useState<SocketState>("idle");
  const sendingMessagesRef = useRef<Map<string, ChatMessage>>(new Map());
  const [callState, setCallState] = useState<ChatCallState>("idle");
  const [incomingCall, setIncomingCall] = useState<{ conversationId: number; fromUserId: number } | null>(null);
  const [localVideoStream, setLocalVideoStream] = useState<MediaStream | null>(null);
  const [remoteVideoStream, setRemoteVideoStream] = useState<MediaStream | null>(null);

  const [isMobile, setIsMobile] = useState(false);
  const [showMobileChat, setShowMobileChat] = useState(false);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const conversationsQuery = useQuery({
    queryKey: ["chat", "conversations", session?.accessToken],
    queryFn: () => fetchConversations(session!),
    enabled: !!session?.accessToken,
    staleTime: 10_000,
  });

  const friendsQuery = useQuery({
    queryKey: ["chat", "friends", session?.accessToken],
    queryFn: () => fetchFriends(session!),
    enabled: !!session?.accessToken && isOpen,
    staleTime: 30_000,
  });

  const effectiveSelectedConversationId = selectedConversationId ?? conversationsQuery.data?.[0]?.id ?? null;

  const activeConversation = useMemo(
    () =>
      conversationsQuery.data?.find(
        (conversation) => conversation.id === effectiveSelectedConversationId,
      ) ?? null,
    [conversationsQuery.data, effectiveSelectedConversationId],
  );

  const messagesQuery = useQuery({
    queryKey: ["chat", "messages", session?.accessToken, effectiveSelectedConversationId],
    queryFn: () => fetchMessages(session!, effectiveSelectedConversationId!),
    enabled: !!session?.accessToken && !!effectiveSelectedConversationId && isOpen,
    staleTime: 2_000,
  });

  useEffect(() => {
    activeConversationRef.current = effectiveSelectedConversationId;
  }, [effectiveSelectedConversationId]);

  useEffect(() => {
    if (localVideoRef.current && localVideoStream) {
      localVideoRef.current.srcObject = localVideoStream;
    }
  }, [localVideoStream]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteVideoStream) {
      remoteVideoRef.current.srcObject = remoteVideoStream;
    }
  }, [remoteVideoStream]);

  function resetCallSession() {
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    pendingCallRef.current = null;
    queuedIceCandidatesRef.current = [];
    setLocalVideoStream(null);
    setRemoteVideoStream(null);
    setCallState("idle");
    setIncomingCall(null);
  }

  function flushPendingIceCandidates(peerConnection: RTCPeerConnection) {
    while (queuedIceCandidatesRef.current.length) {
      const candidate = queuedIceCandidatesRef.current.shift();
      if (!candidate) continue;
      try {
        void peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        queuedIceCandidatesRef.current.unshift(candidate);
        break;
      }
    }
  }

  async function addIceCandidate(peerConnection: RTCPeerConnection, candidate: RTCIceCandidateInit) {
    if (!candidate) return;

    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {
      queuedIceCandidatesRef.current.push(candidate);
    }
  }

  async function getIceServers(): Promise<RTCIceServer[]> {
    if (iceServersPromiseRef.current) return iceServersPromiseRef.current;

    iceServersPromiseRef.current = (async () => {
      try {
        const response = await fetch(`${BACKEND_URL}/call/ice-servers`, {
          cache: "no-store",
        });

        if (!response.ok) throw new Error("Failed to fetch ICE servers");

        return (await response.json()) as RTCIceServer[];
      } catch (error) {
        console.error("Failed to fetch ICE servers:", error);
        return [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
        ];
      }
    })();

    return iceServersPromiseRef.current;
  }

  async function ensurePeerConnection(targetUserId: number) {
    if (peerConnectionRef.current) {
      return peerConnectionRef.current;
    }

    const iceServers = await getIceServers();
    const peerConnection = new RTCPeerConnection({
      iceServers,
    });

    peerConnection.onicecandidate = (event) => {
      if (event.candidate && socketRef.current && pendingCallRef.current) {
        socketRef.current.emit("call:ice-candidate", {
          conversationId: pendingCallRef.current.conversationId,
          targetUserId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    peerConnection.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) {
        remoteStreamRef.current = stream;
        setRemoteVideoStream(stream);
      }
    };

    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === "failed" || peerConnection.connectionState === "closed") {
        resetCallSession();
      }
    };

    peerConnectionRef.current = peerConnection;
    return peerConnection;
  }

  useEffect(() => {
    if (!session?.accessToken) return;

    const socket = io(BACKEND_URL, {
      transports: ["websocket"],
      auth: {
        token: `Bearer ${session.accessToken}`,
      },
    });
    const manager = socket.io;
    const handleReconnectAttempt = () => {
      setSocketState("connecting");
    };
    const handleReconnectFailed = () => {
      setSocketState("idle");
    };

    socketRef.current = socket;

    socket.on("connect", () => {
      setSocketState("connected");
    });

    socket.on("disconnect", () => {
      setSocketState(socket.active ? "connecting" : "idle");
    });

    socket.on("connect_error", (error) => {
      if (shouldSignOutFromError(error)) {
        redirectToSignOut();
        return;
      }
      setSocketState("connecting");
    });

    manager.on("reconnect_attempt", handleReconnectAttempt);

    manager.on("reconnect_failed", handleReconnectFailed);

    socket.on("message:new", (message: SocketMessage & { tempId?: string }) => {
      if (message.tempId) {
        sendingMessagesRef.current.delete(message.tempId);
      }

      queryClient.setQueryData<ChatMessage[]>(
        ["chat", "messages", session.accessToken, message.conversationId],
        (current) => {
          if (!current) return [{ ...message, status: "sent" as const }];
          const optimisticIndex = message.tempId
            ? current.findIndex((item) => item.tempId === message.tempId)
            : -1;
          if (optimisticIndex >= 0) {
            return current.map((item) =>
              item.tempId === message.tempId
                ? { ...message, status: "sent" as const, tempId: undefined }
                : item,
            );
          }
          const existsById = current.some((item) => item.id === message.id && message.id > 0);
          if (existsById) return current;

          return [...current, { ...message, status: "sent" as const }];
        },
      );

      queryClient.setQueryData<ChatConversation[]>(
        ["chat", "conversations", session.accessToken],
        (current) => {
          if (!current) return current;

          return current.map((conversation) => {
            if (conversation.id !== message.conversationId) return conversation;
            return {
              ...conversation,
              lastMessage: { ...message, status: "sent" as const },
              lastMessageId: message.id,
              updatedAt: message.createdAt,
            };
          });
        },
      );

      if (activeConversationRef.current === message.conversationId) {
        queryClient.invalidateQueries({
          queryKey: ["chat", "conversations", session.accessToken],
        });
      }
    });

    socket.on("conversation:updated", () => {
      queryClient.invalidateQueries({
        queryKey: ["chat", "conversations", session.accessToken],
      });
    });

    socket.on("message:error", (payload: { tempId?: string; conversationId: number; error: string }) => {
      if (payload.tempId) {
        sendingMessagesRef.current.delete(payload.tempId);
        queryClient.setQueryData<ChatMessage[]>(
          ["chat", "messages", session.accessToken, payload.conversationId],
          (current) => {
            if (!current) return current;
            return current.map((msg) =>
              msg.tempId === payload.tempId ? { ...msg, status: "failed" as const } : msg,
            );
          },
        );
      }
    });

    socket.on("conversation:read", (payload: { conversationId: number; lastReadAt: string }) => {
      queryClient.invalidateQueries({
        queryKey: ["chat", "conversations", session.accessToken],
      });

      queryClient.setQueryData<ChatConversation[]>(
        ["chat", "conversations", session.accessToken],
        (current) => {
          if (!current) return current;
          return current.map((conversation) =>
            conversation.id === payload.conversationId
              ? {
                  ...conversation,
                  members: conversation.members.map((member) =>
                    member.userId === Number(session.user.id)
                      ? { ...member, lastReadAt: payload.lastReadAt }
                      : member,
                  ),
                }
              : conversation,
          );
        },
      );
    });

    socket.on("call:incoming", (payload: { conversationId: number; fromUserId: number }) => {
      setIncomingCall(payload);
      setCallState("incoming");
    });

    socket.on("call:accepted", async () => {
      setCallState("connected");

      const pending = pendingCallRef.current;
      if (!pending) return;

      const peer = await ensurePeerConnection(pending.targetUserId);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      socketRef.current?.emit("call:offer", {
        conversationId: pending.conversationId,
        targetUserId: pending.targetUserId,
        offer,
      });
    });

    socket.on("call:offer", async (payload: { fromUserId: number; offer: RTCSessionDescriptionInit }) => {
      const conversationId = pendingCallRef.current?.conversationId;
      if (!conversationId) return;

      const peer = await ensurePeerConnection(payload.fromUserId);
      await peer.setRemoteDescription(new RTCSessionDescription(payload.offer));
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socketRef.current?.emit("call:answer", {
        conversationId,
        targetUserId: payload.fromUserId,
        answer,
      });
      setCallState("connected");
    });

    socket.on("call:answer", async (payload: { fromUserId: number; answer: RTCSessionDescriptionInit }) => {
      const peer = await ensurePeerConnection(payload.fromUserId);
      await peer.setRemoteDescription(new RTCSessionDescription(payload.answer));
      flushPendingIceCandidates(peer);
    });

    socket.on("call:ice-candidate", async (payload: { fromUserId: number; candidate: RTCIceCandidateInit }) => {
      const peer = await ensurePeerConnection(payload.fromUserId);
      await addIceCandidate(peer, payload.candidate);
    });

    socket.on("call:rejected", () => {
      resetCallSession();
    });

    socket.on("call:ended", () => {
      resetCallSession();
    });

    return () => {
      socket.removeAllListeners();
      manager.off("reconnect_attempt", handleReconnectAttempt);
      manager.off("reconnect_failed", handleReconnectFailed);
      socket.disconnect();
      socketRef.current = null;
      setSocketState("idle");
    };
  }, [queryClient, session]);

  useEffect(() => {
    if (!isOpen || !effectiveSelectedConversationId || !socketRef.current) return;
    socketRef.current.emit("conversation:join", { conversationId: effectiveSelectedConversationId });
  }, [isOpen, effectiveSelectedConversationId]);

  useEffect(() => {
    if (!isOpen || !effectiveSelectedConversationId || !session?.accessToken) return;
    void markConversationRead(session, effectiveSelectedConversationId).then(() => {
      queryClient.invalidateQueries({
        queryKey: ["chat", "conversations", session.accessToken],
      });
    });
  }, [isOpen, effectiveSelectedConversationId, queryClient, session]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messagesQuery.data, effectiveSelectedConversationId, isOpen]);

  const unreadCount =
    conversationsQuery.data && session?.user?.id
      ? conversationsQuery.data.reduce((count, conversation) => {
          if (conversation.id === effectiveSelectedConversationId && isOpen) return count;

          const lastMessage = conversation.lastMessage;
          if (!lastMessage) return count;

          const me = conversation.members.find((member) => String(member.userId) === String(session.user.id));
          const lastReadAt = me?.lastReadAt ? new Date(me.lastReadAt).getTime() : 0;
          const messageTime = new Date(lastMessage.createdAt).getTime();
          return messageTime > lastReadAt ? count + 1 : count;
        }, 0)
      : 0;

  const sendMessageMutation = useMutation({
    mutationFn: async ({ content, conversationId, tempId }: OutgoingMessage) => {
      if (!session?.accessToken) throw new Error("Missing session");
      if (!socketRef.current) {
        throw new Error("Socket unavailable");
      }

      if (!socketRef.current.connected) {
        setSocketState("connecting");
      }
      await waitForSocketConnection(socketRef.current);
      setSocketState("connected");

      return new Promise<{ tempId: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Message acknowledgement timeout")), 15_000);

        socketRef.current?.emit(
          "message:send",
          {
            conversationId,
            content,
            type: "TEXT",
            tempId,
          },
          (response?: { ok?: boolean; message?: string; error?: string }) => {
            clearTimeout(timer);
            if (response?.ok) {
              resolve({ tempId });
              return;
            }
            reject(new Error(response?.error || response?.message || "Failed to queue message"));
          },
        );
      });
    },
    onMutate: async ({ content, conversationId, tempId }) => {
      const nextDraft = content.trim();
      if (nextDraft) {
        setMessageDraft("");
      }

      const tempMessage: ChatMessage = {
        id: -Date.now(),
        tempId,
        conversationId,
        senderId: Number(session?.user?.id ?? 0),
        type: "TEXT",
        content: nextDraft,
        status: "sending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sender: {
          id: Number(session?.user?.id ?? 0),
          name: session?.user?.name ?? "You",
          avatar: session?.user?.avatar ?? null,
        },
      };

      sendingMessagesRef.current.set(tempId, tempMessage);

      queryClient.setQueryData<ChatMessage[]>(
        ["chat", "messages", session?.accessToken, conversationId],
        (current) => {
          if (!current) return [tempMessage];
          if (current.some((message) => message.tempId === tempId)) return current;
          return [...current, tempMessage];
        },
      );

      queryClient.setQueryData<ChatConversation[]>(
        ["chat", "conversations", session?.accessToken],
        (current) => {
          if (!current) return current;
          return current.map((conversation) => {
            if (conversation.id !== conversationId) return conversation;
            return {
              ...conversation,
              lastMessage: tempMessage,
              updatedAt: tempMessage.createdAt,
            };
          });
        },
      );

      return { tempId, conversationId };
    },
    onError: (error, _variables, context) => {
      if (shouldSignOutFromError(error)) {
        redirectToSignOut();
        return;
      }

      if (context?.tempId) {
        const tempId = context.tempId;
        sendingMessagesRef.current.delete(tempId);
        queryClient.setQueryData<ChatMessage[]>(
          ["chat", "messages", session?.accessToken, context.conversationId],
          (current) => {
            if (!current) return current;
            return current.map((msg) =>
              msg.tempId === tempId ? { ...msg, status: "failed" as const } : msg,
            );
          },
        );

        queryClient.setQueryData<ChatConversation[]>(
          ["chat", "conversations", session?.accessToken],
          (current) => {
            if (!current) return current;
            return current.map((conversation) => {
              if (conversation.id !== context.conversationId || conversation.lastMessage?.tempId !== tempId) {
                return conversation;
              }

              return {
                ...conversation,
                lastMessage: { ...conversation.lastMessage, status: "failed" as const },
              };
            });
          },
        );
      }
    },
  });

  const endCall = () => {
    const pending = pendingCallRef.current;

    if (socketRef.current && pending) {
      socketRef.current.emit("call:hangup", {
        conversationId: pending.conversationId,
        targetUserId: pending.targetUserId,
      });
    }

    resetCallSession();
  };

  const startCall = async () => {
    if (!session?.accessToken || !effectiveSelectedConversationId || !activeConversation) return;
    const otherMember = activeConversation.members.find(
      (member) => String(member.userId) !== String(session.user.id),
    );

    if (!otherMember || !socketRef.current || socketState !== "connected") return;

    setCallState("calling");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStreamRef.current = stream;
      setLocalVideoStream(stream);

      const peerConnection = await ensurePeerConnection(otherMember.userId);
      stream.getTracks().forEach((track) => peerConnection.addTrack(track, stream));

      pendingCallRef.current = {
        conversationId: effectiveSelectedConversationId,
        targetUserId: otherMember.userId,
      };

      socketRef.current.emit(
        "call:invite",
        {
          conversationId: effectiveSelectedConversationId,
          targetUserId: otherMember.userId,
        },
        (response: { event?: string }) => {
          if (response?.event === "call:invite:failed") {
            resetCallSession();
          }
        },
      );
    } catch {
      resetCallSession();
    }
  };

  const acceptCall = async () => {
    if (!incomingCall || !socketRef.current) return;

    setCallState("connected");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStreamRef.current = stream;
      setLocalVideoStream(stream);

      const peerConnection = await ensurePeerConnection(incomingCall.fromUserId);
      stream.getTracks().forEach((track) => peerConnection.addTrack(track, stream));

      pendingCallRef.current = {
        conversationId: incomingCall.conversationId,
        targetUserId: incomingCall.fromUserId,
      };

      socketRef.current.emit("call:accept", {
        conversationId: incomingCall.conversationId,
        fromUserId: incomingCall.fromUserId,
      });
      setIncomingCall(null);
    } catch {
      setCallState("connected");
    }
  };

  const rejectCall = () => {
    if (!incomingCall || !socketRef.current) return;
    socketRef.current.emit("call:reject", {
      conversationId: incomingCall.conversationId,
      fromUserId: incomingCall.fromUserId,
    });
    resetCallSession();
  };

  const createDirectMutation = useMutation({
    mutationFn: async (participantId: number) => {
      if (!session) throw new Error("Missing session");
      return createDirectConversation(session, participantId);
    },
    onSuccess: async (conversation) => {
      setSelectedConversationId(conversation.id);
      setIsOpen(true);
      setActiveTab("chats");
      if (session?.accessToken) {
        await queryClient.invalidateQueries({
          queryKey: ["chat", "conversations", session.accessToken],
        });
      }
    },
  });

  const activeMessages = messagesQuery.data ?? [];

  const handleSelectConversation = (conversationId: number) => {
    setSelectedConversationId(conversationId);
    if (isMobile) {
      setShowMobileChat(true);
    }
  };

  if (!session) {
    return (
      <div className="fixed bottom-4 right-4 z-50">
        <Link
          href="/auth/signin"
          className="group flex items-center gap-3 rounded-full border border-border bg-background/95 px-4 py-3 text-sm shadow-[0_24px_80px_-24px_rgba(0,0,0,0.35)] backdrop-blur-xl transition-transform duration-200 hover:-translate-y-1"
        >
          <span className="flex size-9 items-center justify-center rounded-full bg-foreground text-background">
            <ChatBubbleLeftRightIcon className="size-5" />
          </span>
          <span className="flex flex-col text-left">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
              Chat
            </span>
            <span className="font-medium">Sign in to message</span>
          </span>
        </Link>
      </div>
    );
  }

  return (
    <div className="fixed inset-x-2 bottom-2 z-50 flex flex-col items-end gap-3 md:inset-x-auto md:right-4 md:bottom-4">
      {isOpen ? (
        <div className="w-[calc(100vw-1rem)] max-w-[920px] overflow-hidden rounded-3xl border border-border bg-[linear-gradient(180deg,rgba(255,255,255,0.97),rgba(248,248,246,0.92))] shadow-[0_24px_100px_-28px_rgba(0,0,0,0.45)] backdrop-blur-2xl dark:bg-[linear-gradient(180deg,rgba(24,24,24,0.96),rgba(18,18,18,0.92))]">
          <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-full bg-foreground text-background">
                <ChatBubbleLeftRightIcon className="size-5" />
              </span>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                  Messages
                </p>
                <p className="text-sm font-medium text-foreground">
                  {socketState === "connected" ? "Live" : session?.accessToken ? "Connecting..." : "Idle"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setIsOpen(false)}
                aria-label="Close chat"
              >
                <XMarkIcon className="size-4" />
              </Button>
            </div>
          </div>

          <div className="grid h-[72dvh] min-h-0 grid-cols-1 overflow-hidden md:h-[min(72vh,760px)] md:grid-cols-[320px_1fr]">
            <ChatSidebar
              session={session}
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              isMobile={isMobile}
              showMobileChat={showMobileChat}
              selectedConversationId={selectedConversationId}
              conversations={conversationsQuery.data}
              conversationsLoading={conversationsQuery.isLoading}
              friends={friendsQuery.data}
              friendsLoading={friendsQuery.isLoading}
              friendFilter={friendFilter}
              setFriendFilter={setFriendFilter}
              onSelectConversation={handleSelectConversation}
              onCreateConversation={(participantId) => createDirectMutation.mutate(participantId)}
              createDirectPending={createDirectMutation.isPending}
            />

            <section
              className={cn(
                "flex h-full min-h-0 flex-col overflow-hidden bg-[radial-gradient(circle_at_top,rgba(0,0,0,0.03),transparent_40%)]",
                isMobile && !showMobileChat && "hidden",
              )}
            >
              <ChatThread
                session={session}
                activeConversation={activeConversation}
                isMobile={isMobile}
                onBack={() => setShowMobileChat(false)}
                socketState={socketState}
                incomingCall={incomingCall}
                callState={callState}
                localVideoStream={localVideoStream}
                remoteVideoStream={remoteVideoStream}
                startCall={startCall}
                acceptCall={acceptCall}
                rejectCall={rejectCall}
                endCall={endCall}
                messagesLoading={messagesQuery.isLoading}
                activeMessages={activeMessages}
                messageDraft={messageDraft}
                setMessageDraft={setMessageDraft}
                onSendMessage={(content) => {
                  if (!effectiveSelectedConversationId) {
                    return;
                  }
                  sendMessageMutation.mutate({
                    content,
                    conversationId: effectiveSelectedConversationId,
                    tempId: crypto.randomUUID(),
                  });
                }}
                scrollRef={scrollRef}
                localVideoRef={localVideoRef}
                remoteVideoRef={remoteVideoRef}
              />
            </section>
          </div>
        </div>
      ) : null}

      <Button
        onClick={() => {
          setIsOpen((value) => {
            if (value) {
              setShowMobileChat(false);
            }
            return !value;
          });
        }}
        className={cn(
          "group h-14 rounded-full px-5 shadow-[0_20px_60px_-24px_rgba(0,0,0,0.45)]",
          isOpen ? "bg-foreground text-background" : "bg-foreground text-background",
        )}
        aria-expanded={isOpen}
        aria-label="Toggle chat"
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-background/10">
          {isOpen ? <XMarkIcon className="size-5" /> : <ChatBubbleLeftRightIcon className="size-5" />}
        </span>
        <span className="flex flex-col items-start gap-0.5 text-left">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-background/65">
            Messenger
          </span>
          <span className="text-sm font-semibold">
            {isOpen ? "Close chat" : unreadCount ? `${unreadCount} unread` : "Open chat"}
          </span>
        </span>
        {unreadCount ? (
          <span className="ml-1 flex size-6 items-center justify-center rounded-full bg-background text-foreground text-xs font-semibold">
            {unreadCount}
          </span>
        ) : null}
      </Button>
    </div>
  );
}
