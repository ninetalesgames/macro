import { useEffect, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { db } from "./firebase";
import type { CoachProposal, EntriesMap, Goals } from "./types";

type ChatMessage = {
  id?: string;
  role: "user" | "assistant";
  content: string;
};

type MealLog = {
  date: string;
  summary: string;
  calories: number;
  protein: number;
};

type CoachResponse = {
  reply: string;
  transcript?: string;
  proposals: CoachProposal[];
};

export default function Coach({
  user,
  entries,
  selectedDate,
  today,
  goals,
  onApplyProposal,
}: {
  user: User;
  entries: EntriesMap;
  selectedDate: string;
  today: string;
  goals: Goals;
  onApplyProposal: (proposal: CoachProposal) => Promise<void>;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [mealLogs, setMealLogs] = useState<MealLog[]>([]);
  const [input, setInput] = useState("");
  const [proposals, setProposals] = useState<CoachProposal[]>([]);
  const [status, setStatus] = useState<"idle" | "working" | "recording">("idle");
  const [error, setError] = useState("");
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRecordingRef = useRef(false);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    async function loadMemory() {
      const messageSnapshot = await getDocs(
        query(
          collection(db, "users", user.uid, "chatMessages"),
          orderBy("createdAt", "desc"),
          limit(30),
        ),
      );
      setMessages(
        messageSnapshot.docs
          .map((messageDoc) => ({ id: messageDoc.id, ...messageDoc.data() }) as ChatMessage)
          .reverse(),
      );

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 90);
      const cutoffKey = cutoff.toISOString().slice(0, 10);
      const mealsSnapshot = await getDocs(
        query(collection(db, "users", user.uid, "mealLogs"), where("date", ">=", cutoffKey), orderBy("date", "desc")),
      );
      setMealLogs(mealsSnapshot.docs.map((mealDoc) => mealDoc.data() as MealLog));
    }

    loadMemory().catch((loadError) => {
      console.error(loadError);
      setError("Could not load Coach memory.");
    });
  }, [user.uid]);

  useEffect(() => {
    if (status !== "recording") return;
    const timer = window.setInterval(() => setRecordingSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [status]);

  useEffect(() => {
    const scrollArea = chatScrollRef.current;
    if (!scrollArea) return;
    window.requestAnimationFrame(() => {
      scrollArea.scrollTo({ top: scrollArea.scrollHeight, behavior: "smooth" });
    });
  }, [messages, proposals, status]);

  const contextEntries = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const cutoffKey = cutoff.toISOString().slice(0, 10);

    return Object.entries(entries)
      .filter(([date]) => date >= cutoffKey || date === selectedDate)
      .map(([date, entry]) => ({ date, ...entry }));
  }, [entries, selectedDate]);

  async function saveMessage(message: ChatMessage) {
    await addDoc(collection(db, "users", user.uid, "chatMessages"), {
      role: message.role,
      content: message.content,
      createdAt: serverTimestamp(),
    });

    const snapshot = await getDocs(
      query(collection(db, "users", user.uid, "chatMessages"), orderBy("createdAt", "desc"), limit(40)),
    );
    await Promise.all(snapshot.docs.slice(30).map((messageDoc) => deleteDoc(messageDoc.ref)));
  }

  function buildContext(message: string) {
    return {
      message,
      today,
      selectedDate,
      goals,
      entries: contextEntries,
      mealLogs,
      recentMessages: messages.slice(-30).map(({ role, content }) => ({ role, content })),
    };
  }

  async function sendRequest(body: BodyInit, contentType?: string) {
    const apiUrl = import.meta.env.VITE_COACH_API_URL as string | undefined;
    if (!apiUrl || apiUrl === "WORKERURLHERE") throw new Error("Coach API URL is not configured.");

    const token = await user.getIdToken();
    const response = await fetch(`${apiUrl.replace(/\/$/, "")}/coach`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
      },
      body,
    });
    const data = await response.json() as CoachResponse & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "Coach request failed.");
    return data;
  }

  async function submitMessage(message: string) {
    const cleanMessage = message.trim();
    if (!cleanMessage || status !== "idle") return;

    setInput("");
    setError("");
    setStatus("working");
    const userMessage: ChatMessage = { role: "user", content: cleanMessage };
    setMessages((current) => [...current, userMessage]);

    try {
      const result = await sendRequest(JSON.stringify(buildContext(cleanMessage)), "application/json");
      const assistantMessage: ChatMessage = { role: "assistant", content: result.reply };
      setMessages((current) => [...current, assistantMessage]);
      setProposals(result.proposals);
      await Promise.all([saveMessage(userMessage), saveMessage(assistantMessage)]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Coach request failed.");
    } finally {
      setStatus("idle");
    }
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Voice recording is not supported in this browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => chunksRef.current.push(event.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        if (discardRecordingRef.current) {
          discardRecordingRef.current = false;
          chunksRef.current = [];
          setStatus("idle");
          return;
        }
        void submitAudio(new Blob(chunksRef.current, { type: recorder.mimeType }));
      };
      recorderRef.current = recorder;
      discardRecordingRef.current = false;
      setRecordingSeconds(0);
      setStatus("recording");
      recorder.start();
    } catch {
      setError("Microphone permission is required for voice logging.");
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setStatus("working");
  }

  function cancelRecording() {
    discardRecordingRef.current = true;
    recorderRef.current?.stop();
    recorderRef.current = null;
  }

  async function submitAudio(audio: Blob) {
    setError("");
    try {
      const form = new FormData();
      form.set("audio", audio, getAudioFilename(audio.type));
      form.set("context", JSON.stringify(buildContext("")));
      const result = await sendRequest(form);
      const transcript = result.transcript?.trim() || "Voice memo";
      const userMessage: ChatMessage = { role: "user", content: transcript };
      const assistantMessage: ChatMessage = { role: "assistant", content: result.reply };
      setMessages((current) => [...current, userMessage, assistantMessage]);
      setProposals(result.proposals);
      await Promise.all([saveMessage(userMessage), saveMessage(assistantMessage)]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Voice log failed.");
    } finally {
      setStatus("idle");
    }
  }

  async function applyProposal(proposal: CoachProposal, index: number) {
    setError("");
    try {
      await onApplyProposal(proposal);
      setProposals((current) => current.filter((_, proposalIndex) => proposalIndex !== index));
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "Could not apply proposal.");
    }
  }

  function updateProposal(index: number, patch: Partial<CoachProposal>) {
    setProposals((current) =>
      current.map((proposal, proposalIndex) => proposalIndex === index ? { ...proposal, ...patch } : proposal),
    );
  }

  return (
    <section className="coach-layout">
      <div className="panel coach-intro">
        <p className="eyebrow">AI nutrition coach</p>
        <h2>Log food by voice or ask about your progress</h2>
        <p>Estimates are always shown for review before they change your journal.</p>
      </div>

      <div className="panel chat-panel">
        <div className="chat-scroll" ref={chatScrollRef}>
          <div className="chat-messages">
            {messages.length === 0 && (
              <div className="empty-chat">Try: "I ate chicken, rice and broccoli for dinner" or "Could my recent diet be affecting recovery?"</div>
            )}
            {messages.map((message, index) => (
              <div key={message.id ?? `${message.role}-${index}`} className={`chat-message ${message.role}`}>
                {message.content}
              </div>
            ))}
            {status === "working" && <div className="chat-message assistant">Thinking...</div>}
          </div>

          {proposals.map((proposal, index) => (
            <ProposalCard
              key={`${proposal.type}-${index}`}
              proposal={proposal}
              onChange={(patch) => updateProposal(index, patch)}
              onApply={() => void applyProposal(proposal, index)}
              onDismiss={() => setProposals((current) => current.filter((_, proposalIndex) => proposalIndex !== index))}
            />
          ))}

          {error && <div className="coach-error">{error}</div>}
        </div>

        <form
          className={`chat-composer ${status === "recording" ? "is-recording" : ""}`}
          onSubmit={(event) => {
            event.preventDefault();
            void submitMessage(input);
          }}
        >
          {status === "recording" ? (
            <div className="recording-bar">
              <button type="button" className="icon-btn cancel-recording" onClick={cancelRecording} aria-label="Cancel recording">
                <TrashIcon />
              </button>
              <div className="recording-status"><span />{formatRecordingTime(recordingSeconds)}</div>
              <button type="button" className="icon-btn send-recording" onClick={stopRecording} aria-label="Send voice memo">
                <SendIcon />
              </button>
            </div>
          ) : (
          <div className="composer-row">
            <textarea
              value={input}
              rows={1}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Message your nutrition coach"
              disabled={status !== "idle"}
            />
            <button
              type="button"
              className="icon-btn composer-submit"
              onClick={input.trim() ? () => void submitMessage(input) : () => void startRecording()}
              disabled={status !== "idle"}
              aria-label={input.trim() ? "Send message" : "Record voice memo"}
            >
              {input.trim() ? <SendIcon /> : <MicIcon />}
            </button>
          </div>
          )}
        </form>
      </div>
    </section>
  );
}

function getAudioFilename(mimeType: string) {
  if (mimeType.includes("mp4")) return "voice.m4a";
  if (mimeType.includes("ogg")) return "voice.ogg";
  if (mimeType.includes("mpeg")) return "voice.mp3";
  if (mimeType.includes("wav")) return "voice.wav";
  return "voice.webm";
}

function formatRecordingTime(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function MicIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a4 4 0 0 0 4-4V7a4 4 0 1 0-8 0v4a4 4 0 0 0 4 4Zm7-4a7 7 0 0 1-14 0m7 7v3m-4 0h8" /></svg>;
}

function SendIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 7-7 7 7m-7-7v14" /></svg>;
}

function TrashIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16m-10 4v6m4-6v6m-8-10 1 14h10l1-14M9 7l1-3h4l1 3" /></svg>;
}

function ProposalCard({
  proposal,
  onChange,
  onApply,
  onDismiss,
}: {
  proposal: CoachProposal;
  onChange: (patch: Partial<CoachProposal>) => void;
  onApply: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="proposal-card">
      <div className="proposal-header">
        <div>
          <strong>Review {proposal.type} update</strong>
          <p>{proposal.summary}</p>
        </div>
        <button className="danger-btn" onClick={onDismiss}>Dismiss</button>
      </div>

      {proposal.type !== "goals" && (
        <label>
          Date
          <input type="date" value={proposal.date ?? ""} onChange={(event) => onChange({ date: event.target.value })} />
        </label>
      )}
      {proposal.type === "meal" && (
        <div className="proposal-grid">
          <ProposalNumber label="Calories to add" value={proposal.calories} onChange={(calories) => onChange({ calories })} />
          <ProposalNumber label="Protein to add" value={proposal.protein} onChange={(protein) => onChange({ protein })} />
        </div>
      )}
      {proposal.type === "weight" && (
        <ProposalNumber label="Weight (kg)" value={proposal.weight} step="0.1" onChange={(weight) => onChange({ weight })} />
      )}
      {proposal.type === "goals" && (
        <div className="proposal-grid">
          <ProposalNumber label="Calorie target" value={proposal.calorieTarget} onChange={(calorieTarget) => onChange({ calorieTarget })} />
          <ProposalNumber label="Protein target" value={proposal.proteinTarget} onChange={(proteinTarget) => onChange({ proteinTarget })} />
        </div>
      )}
      <p className="uncertainty">{proposal.uncertainty || "AI nutrition values are estimates."}</p>
      <button className="apply-btn" onClick={onApply}>Confirm and apply</button>
    </div>
  );
}

function ProposalNumber({
  label,
  value,
  step = "1",
  onChange,
}: {
  label: string;
  value: number | null;
  step?: string;
  onChange: (value: number | null) => void;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        min="0"
        step={step}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
      />
    </label>
  );
}
