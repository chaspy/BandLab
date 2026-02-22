"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { API_BASE } from "../../../lib/config";
import { apiFetch } from "../../../lib/api";
import { getMockAssetStreamUrl, MOCK_API_ENABLED, mockUploadAssetFile } from "../../../lib/mock";
import { supabase } from "../../../lib/supabase";

type Song = {
  id: string;
  title: string;
  bpm: number | null;
  musical_key: string | null;
  time_signature: string | null;
  description: string | null;
  lyrics: string | null;
};

type Track = {
  id: string;
  song_id: string;
  name: string;
  instrument_type: string | null;
  sort_order: number;
  active_revision_id: string | null;
};

type Asset = {
  id: string;
  asset_type: "audio_preview" | "audio_source" | "midi";
  format: string;
  status: "pending" | "uploaded" | "ready" | "failed";
};

type Revision = {
  id: string;
  track_id: string;
  revision_number: number;
  title: string | null;
  memo: string | null;
  track_assets: Asset[];
};

type MixSession = { id: string; song_id: string; name: string };

type MixSessionTrack = {
  track_id: string;
  track_revision_id: string | null;
  mute: boolean;
  gain_db: number;
  pan: number;
  start_offset_ms: number;
};

type Note = { id: string; content: string };
type Decision = { id: string; title: string; decision_text: string; reasoning: string | null };

const dbToLinear = (db: number) => Math.pow(10, db / 20);

export default function SongDetailPage() {
  const params = useParams<{ songId: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const songId = params.songId;
  const bandId = search.get("bandId") || "";

  const [song, setSong] = useState<Song | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [revisionsByTrack, setRevisionsByTrack] = useState<Record<string, Revision[]>>({});
  const [sessions, setSessions] = useState<MixSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [sessionTracks, setSessionTracks] = useState<Record<string, MixSessionTrack>>({});
  const [notes, setNotes] = useState<Note[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [trackName, setTrackName] = useState("New Track");
  const [newSessionName, setNewSessionName] = useState("Session A");
  const [newNote, setNewNote] = useState("");
  const [newDecisionTitle, setNewDecisionTitle] = useState("");
  const [newDecisionText, setNewDecisionText] = useState("");
  const [bpmInput, setBpmInput] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [lyricsInput, setLyricsInput] = useState("");
  const [metaDirty, setMetaDirty] = useState(false);
  const [metaSaving, setMetaSaving] = useState(false);
  const [metaSaved, setMetaSaved] = useState(false);
  const [lyricsDirty, setLyricsDirty] = useState(false);
  const [lyricsSaving, setLyricsSaving] = useState(false);
  const [lyricsSaved, setLyricsSaved] = useState(false);
  const [error, setError] = useState("");

  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const gainNodes = useRef<Record<string, GainNode>>({});
  const panNodes = useRef<Record<string, StereoPannerNode>>({});
  const ctxRef = useRef<AudioContext | null>(null);
  const recorderRefs = useRef<Record<string, MediaRecorder | null>>({});
  const recordChunks = useRef<Record<string, BlobPart[]>>({});
  const recordStreams = useRef<Record<string, MediaStream | null>>({});
  const [recordingTrackId, setRecordingTrackId] = useState<string | null>(null);

  useEffect(() => {
    if (!songId || !bandId) return;
    loadAll();
  }, [songId, bandId]);

  useEffect(() => {
    syncAudioRouting();
  }, [tracks, sessionTracks]);

  useEffect(() => {
    return () => {
      for (const trackId of Object.keys(recorderRefs.current)) {
        stopRecording(trackId);
      }
    };
  }, []);

  useEffect(() => {
    setBpmInput(song?.bpm ? String(song.bpm) : "");
    setKeyInput(song?.musical_key ?? "");
    setLyricsInput(song?.lyrics ?? "");
    setMetaDirty(false);
    setLyricsDirty(false);
  }, [song?.id]);

  const sortedTracks = useMemo(() => [...tracks].sort((a, b) => a.sort_order - b.sort_order), [tracks]);

  async function loadAll() {
    try {
      const [songRes, tracksRes, sessionsRes, notesRes, decisionsRes] = await Promise.all([
        apiFetch<{ song: Song }>(`/api/songs/${songId}`),
        apiFetch<{ tracks: Track[] }>(`/api/songs/${songId}/tracks`),
        apiFetch<{ sessions: MixSession[] }>(`/api/songs/${songId}/sessions`),
        apiFetch<{ notes: Note[] }>(`/api/songs/${songId}/notes`),
        apiFetch<{ decisions: Decision[] }>(`/api/songs/${songId}/decisions`)
      ]);

      setSong(songRes.song);
      setTracks(tracksRes.tracks);
      setSessions(sessionsRes.sessions);
      setNotes(notesRes.notes);
      setDecisions(decisionsRes.decisions);

      const revisionsEntries = await Promise.all(
        tracksRes.tracks.map(async (t) => {
          const res = await apiFetch<{ revisions: Revision[] }>(`/api/tracks/${t.id}/revisions`);
          return [t.id, res.revisions] as const;
        })
      );
      setRevisionsByTrack(Object.fromEntries(revisionsEntries));

      if (sessionsRes.sessions[0]) {
        await selectSession(sessionsRes.sessions[0].id);
      } else {
        setSessionTracks(
          Object.fromEntries(
            tracksRes.tracks.map((t) => [
              t.id,
              {
                track_id: t.id,
                track_revision_id: t.active_revision_id,
                mute: false,
                gain_db: 0,
                pan: 0,
                start_offset_ms: 0
              }
            ])
          )
        );
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function selectSession(sessionId: string) {
    setSelectedSessionId(sessionId);
    const res = await apiFetch<{ session: { tracks: MixSessionTrack[] } }>(`/api/sessions/${sessionId}`);
    setSessionTracks(Object.fromEntries(res.session.tracks.map((x) => [x.track_id, x])));
  }

  async function createTrack(e: FormEvent) {
    e.preventDefault();
    try {
      await apiFetch(`/api/songs/${songId}/tracks`, {
        method: "POST",
        body: JSON.stringify({ name: trackName, instrument_type: "other" })
      });
      setTrackName("New Track");
      await loadAll();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function saveSongMeta() {
    try {
      setMetaSaving(true);
      await apiFetch(`/api/songs/${songId}`, {
        method: "PATCH",
        body: JSON.stringify({
          bpm: bpmInput.trim() ? Number(bpmInput) : null,
          key: keyInput.trim() || null
        })
      });
      await loadAll();
      setMetaDirty(false);
      setMetaSaved(true);
      setTimeout(() => setMetaSaved(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMetaSaving(false);
    }
  }

  useEffect(() => {
    if (!song || !metaDirty) return;
    const nextBpm = bpmInput.trim() ? Number(bpmInput) : null;
    const nextKey = keyInput.trim() || null;
    if (nextBpm === song.bpm && nextKey === song.musical_key) {
      setMetaDirty(false);
      return;
    }

    const timer = setTimeout(() => {
      void saveSongMeta();
    }, 500);

    return () => clearTimeout(timer);
  }, [bpmInput, keyInput, song?.id, metaDirty]);

  async function saveLyrics() {
    try {
      setLyricsSaving(true);
      await apiFetch(`/api/songs/${songId}`, {
        method: "PATCH",
        body: JSON.stringify({ lyrics: lyricsInput })
      });
      setLyricsDirty(false);
      setLyricsSaved(true);
      setTimeout(() => setLyricsSaved(false), 2000);
      await loadAll();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLyricsSaving(false);
    }
  }

  useEffect(() => {
    if (!song || !lyricsDirty) return;
    if ((song.lyrics ?? "") === lyricsInput) {
      setLyricsDirty(false);
      return;
    }

    const timer = setTimeout(() => {
      void saveLyrics();
    }, 600);

    return () => clearTimeout(timer);
  }, [lyricsInput, song?.id, lyricsDirty]);

  async function setActive(trackId: string, revisionId: string) {
    try {
      await apiFetch(`/api/tracks/${trackId}/active`, {
        method: "POST",
        body: JSON.stringify({ track_revision_id: revisionId })
      });
      await loadAll();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function renameTrack(trackId: string, currentName: string) {
    const next = window.prompt("トラック名を編集", currentName);
    if (next === null || !next.trim()) return;
    try {
      await apiFetch(`/api/tracks/${trackId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: next.trim() })
      });
      await loadAll();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function uploadAsset(trackId: string, assetType: "audio_preview" | "audio_source" | "midi", file: File) {
    try {
      const created = await apiFetch<{ revision: { id: string } }>(`/api/tracks/${trackId}/revisions`, {
        method: "POST",
        body: JSON.stringify({})
      });
      const revisionId = created.revision.id;

      await apiFetch(`/api/tracks/${trackId}/active`, {
        method: "POST",
        body: JSON.stringify({ track_revision_id: revisionId })
      });

      const lower = file.name.toLowerCase();
      const format = lower.endsWith(".wav")
        ? "wav"
        : lower.endsWith(".mid") || lower.endsWith(".midi")
          ? "mid"
          : lower.endsWith(".webm")
            ? "webm"
            : "mp3";

      const presign = await apiFetch<{
        asset_id: string;
        upload_url: string;
        required_headers: Record<string, string>;
      }>(`/api/revisions/${revisionId}/assets/presign`, {
        method: "POST",
        body: JSON.stringify({
          asset_type: assetType,
          format,
          content_type: file.type || (format === "mid" ? "audio/midi" : "application/octet-stream"),
          byte_size: file.size,
          filename: file.name
        })
      });

      if (MOCK_API_ENABLED) {
        await mockUploadAssetFile(presign.asset_id, file);
      } else {
        const putRes = await fetch(presign.upload_url, {
          method: "PUT",
          headers: presign.required_headers,
          body: file
        });

        if (!putRes.ok) {
          throw new Error(`Upload failed: ${putRes.status}`);
        }
      }

      await apiFetch(`/api/assets/${presign.asset_id}/complete`, {
        method: "POST",
        body: JSON.stringify({ byte_size: file.size })
      });

      await loadAll();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function startRecording(trackId: string) {
    if (recordingTrackId && recordingTrackId !== trackId) {
      setError("別トラックを録音中です。先に停止してください。");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      recordStreams.current[trackId] = stream;
      recordChunks.current[trackId] = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordChunks.current[trackId].push(event.data);
        }
      };

      recorder.onerror = () => {
        setError("録音に失敗しました");
      };

      recorder.onstop = async () => {
        try {
          const chunks = recordChunks.current[trackId] ?? [];
          if (chunks.length === 0) return;
          const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          const file = new File([blob], `record-${Date.now()}.webm`, { type: blob.type });
          await uploadAsset(trackId, "audio_preview", file);
        } finally {
          recordChunks.current[trackId] = [];
          const s = recordStreams.current[trackId];
          s?.getTracks().forEach((t) => t.stop());
          recordStreams.current[trackId] = null;
          recorderRefs.current[trackId] = null;
          setRecordingTrackId((prev) => (prev === trackId ? null : prev));
        }
      };

      recorderRefs.current[trackId] = recorder;
      recorder.start();
      setRecordingTrackId(trackId);
      setError("");
    } catch (e) {
      setError((e as Error).message || "マイクへのアクセスに失敗しました");
    }
  }

  function stopRecording(trackId: string) {
    const recorder = recorderRefs.current[trackId];
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
      return;
    }

    const s = recordStreams.current[trackId];
    s?.getTracks().forEach((t) => t.stop());
    recordStreams.current[trackId] = null;
    recorderRefs.current[trackId] = null;
    setRecordingTrackId((prev) => (prev === trackId ? null : prev));
  }

  function getPreviewAssetId(trackId: string): string | null {
    const st = sessionTracks[trackId];
    const targetRevisionId = st?.track_revision_id ?? tracks.find((t) => t.id === trackId)?.active_revision_id;
    if (!targetRevisionId) return null;
    const revisions = revisionsByTrack[trackId] ?? [];
    const revision = revisions.find((r) => r.id === targetRevisionId);
    if (!revision) return null;
    const preview = revision.track_assets.find((a) => a.asset_type === "audio_preview" && a.status === "ready");
    const source = revision.track_assets.find((a) => a.asset_type === "audio_source" && a.status === "ready");
    return preview?.id ?? source?.id ?? null;
  }

  async function streamUrl(assetId: string) {
    if (MOCK_API_ENABLED) {
      return getMockAssetStreamUrl(assetId);
    }
    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;
    return `${API_BASE}/api/assets/${assetId}/stream?token=${encodeURIComponent(token || "")}`;
  }

  async function playAll() {
    await ensureAudioContext();
    const first = sortedTracks[0];
    const masterTime = first ? audioRefs.current[first.id]?.currentTime ?? 0 : 0;

    await Promise.all(
      sortedTracks.map(async (track) => {
        const el = audioRefs.current[track.id];
        if (!el) return;
        if (!el.src) {
          const aid = getPreviewAssetId(track.id);
          if (aid) el.src = await streamUrl(aid);
        }
        el.currentTime = Math.max(masterTime, 0);
        await el.play().catch(() => undefined);
      })
    );
  }

  function pauseAll() {
    sortedTracks.forEach((track) => {
      const el = audioRefs.current[track.id];
      if (el) el.pause();
    });
  }

  async function seekAll(value: number) {
    sortedTracks.forEach((track) => {
      const el = audioRefs.current[track.id];
      if (el) el.currentTime = value;
    });
  }

  async function ensureAudioContext() {
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext();
    }
    if (ctxRef.current.state === "suspended") {
      await ctxRef.current.resume();
    }
  }

  function syncAudioRouting() {
    const ctx = ctxRef.current;
    if (!ctx) return;

    for (const track of sortedTracks) {
      const audio = audioRefs.current[track.id];
      if (!audio || gainNodes.current[track.id]) continue;

      const source = ctx.createMediaElementSource(audio);
      const gain = ctx.createGain();
      const panner = ctx.createStereoPanner();
      source.connect(gain);
      gain.connect(panner);
      panner.connect(ctx.destination);
      gainNodes.current[track.id] = gain;
      panNodes.current[track.id] = panner;
    }

    for (const track of sortedTracks) {
      const setting = sessionTracks[track.id];
      const gain = gainNodes.current[track.id];
      const pan = panNodes.current[track.id];
      if (!gain || !pan) continue;

      const gainDb = setting?.gain_db ?? 0;
      const mute = setting?.mute ?? false;
      gain.gain.value = mute ? 0 : dbToLinear(gainDb);
      pan.pan.value = setting?.pan ?? 0;
    }
  }

  async function createSession(base: "active" | "latest") {
    try {
      await apiFetch(`/api/songs/${songId}/sessions`, {
        method: "POST",
        body: JSON.stringify({ name: newSessionName, base })
      });
      await loadAll();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function saveSessionTracks() {
    if (!selectedSessionId) return;
    try {
      await apiFetch(`/api/sessions/${selectedSessionId}/tracks`, {
        method: "PUT",
        body: JSON.stringify({ tracks: Object.values(sessionTracks) })
      });
      await loadAll();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function patchSessionTrack(trackId: string, patch: Partial<MixSessionTrack>) {
    setSessionTracks((prev) => ({
      ...prev,
      [trackId]: {
        ...prevSessionTrack(trackId, tracks, prev),
        ...prev[trackId],
        ...patch
      }
    }));
  }

  async function createNote(e: FormEvent) {
    e.preventDefault();
    if (!newNote.trim()) return;
    await apiFetch(`/api/songs/${songId}/notes`, {
      method: "POST",
      body: JSON.stringify({ content: newNote })
    });
    setNewNote("");
    await loadAll();
  }

  async function deleteNote(noteId: string) {
    await apiFetch(`/api/notes/${noteId}`, { method: "DELETE" });
    await loadAll();
  }

  async function editNote(noteId: string, content: string) {
    const next = window.prompt("Noteを編集", content);
    if (next === null || !next.trim()) return;
    await apiFetch(`/api/notes/${noteId}`, {
      method: "PATCH",
      body: JSON.stringify({ content: next })
    });
    await loadAll();
  }

  async function createDecision(e: FormEvent) {
    e.preventDefault();
    await apiFetch(`/api/songs/${songId}/decisions`, {
      method: "POST",
      body: JSON.stringify({ title: newDecisionTitle, decision_text: newDecisionText, reasoning: "" })
    });
    setNewDecisionTitle("");
    setNewDecisionText("");
    await loadAll();
  }

  async function deleteDecision(decisionId: string) {
    await apiFetch(`/api/decisions/${decisionId}`, { method: "DELETE" });
    await loadAll();
  }

  async function editDecision(decision: Decision) {
    const title = window.prompt("タイトル", decision.title);
    if (title === null || !title.trim()) return;
    const decisionText = window.prompt("決定内容", decision.decision_text);
    if (decisionText === null || !decisionText.trim()) return;
    const reasoning = window.prompt("理由", decision.reasoning ?? "") ?? "";

    await apiFetch(`/api/decisions/${decision.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        title,
        decision_text: decisionText,
        reasoning
      })
    });
    await loadAll();
  }

  return (
    <main className="grid">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <button onClick={() => router.push("/")}>Back</button>
        <h1>{song?.title ?? "Song Detail"}</h1>
        <small>
          BPM {song?.bpm ?? "-"} | Key {song?.musical_key ?? "-"}
        </small>
      </div>

      <div className="card row" style={{ gap: 12, alignItems: "flex-end" }}>
        <label className="col" style={{ maxWidth: 180 }}>
          BPM
          <input
            type="number"
            min={1}
            max={400}
            value={bpmInput}
            onChange={(e) => {
              setBpmInput(e.target.value);
              setMetaDirty(true);
            }}
          />
        </label>
        <label className="col" style={{ maxWidth: 220 }}>
          Key
          <input
            value={keyInput}
            onChange={(e) => {
              setKeyInput(e.target.value);
              setMetaDirty(true);
            }}
            placeholder="e.g. F#m"
          />
        </label>
        {metaSaving ? <small>Saving...</small> : metaSaved ? <small>Saved</small> : null}
      </div>

      <div className="card col">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2>Lyrics</h2>
          {lyricsSaving
            ? <small>Saving...</small>
            : lyricsSaved
              ? <small>Saved</small>
              : null}
        </div>
        <textarea
          rows={8}
          placeholder="歌詞を入力..."
          value={lyricsInput}
          onChange={(e) => {
            setLyricsInput(e.target.value);
            setLyricsDirty(true);
          }}
        />
      </div>

      <div className="card col">
        <h2>Player + Mix Session</h2>
        <div className="row">
          <select value={selectedSessionId} onChange={(e) => selectSession(e.target.value)}>
            <option value="">No Session</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <input value={newSessionName} onChange={(e) => setNewSessionName(e.target.value)} />
          <button onClick={() => createSession("active")}>Save Active</button>
          <button onClick={() => createSession("latest")}>Save Latest</button>
          <button className="primary" onClick={saveSessionTracks}>Update Session</button>
        </div>

        <div className="row">
          <button className="primary" onClick={playAll}>Play</button>
          <button onClick={pauseAll}>Pause</button>
          <input type="range" min={0} max={360} step={0.1} onChange={(e) => seekAll(Number(e.target.value))} />
        </div>
      </div>

      <div className="card col">
        <h2>Tracks (DAW Lanes)</h2>
        <form className="row" onSubmit={createTrack}>
          <input value={trackName} onChange={(e) => setTrackName(e.target.value)} />
          <button type="submit" className="primary">Add</button>
        </form>

        {sortedTracks.map((track) => {
          const revisions = revisionsByTrack[track.id] || [];
          const activeRevision = revisions.find((r) => r.id === track.active_revision_id);
          return (
            <div key={track.id} className="card col" style={{ padding: 12, borderColor: "#3a4558" }}>
              <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
                <div className="row" style={{ gap: 12 }}>
                  <strong>{track.name}</strong>
                  <button onClick={() => renameTrack(track.id, track.name)}>Rename</button>
                  <label className="row" style={{ gap: 6 }}>
                    <small>Active:</small>
                    <select
                      value={track.active_revision_id || ""}
                      onChange={(e) => e.target.value && setActive(track.id, e.target.value)}
                      style={{ width: 120 }}
                    >
                      <option value="" disabled>
                        -
                      </option>
                      {revisions.map((r) => (
                        <option key={r.id} value={r.id}>
                          r{r.revision_number}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>

              <div className="row" style={{ flexWrap: "wrap" }}>
                <label>
                  <input
                    type="file"
                    style={{ display: "none" }}
                    accept="audio/mp3,audio/mpeg"
                    onChange={(e) => e.target.files?.[0] && uploadAsset(track.id, "audio_preview", e.target.files[0])}
                  />
                  <span className="button-like">mp3 upload</span>
                </label>
                <label>
                  <input
                    type="file"
                    style={{ display: "none" }}
                    accept="audio/wav"
                    onChange={(e) => e.target.files?.[0] && uploadAsset(track.id, "audio_source", e.target.files[0])}
                  />
                  <span className="button-like">wav upload</span>
                </label>
                <label>
                  <input
                    type="file"
                    style={{ display: "none" }}
                    accept=".mid,.midi,audio/midi"
                    onChange={(e) => e.target.files?.[0] && uploadAsset(track.id, "midi", e.target.files[0])}
                  />
                  <span className="button-like">midi upload</span>
                </label>
                {recordingTrackId === track.id ? (
                  <button className="danger" onClick={() => stopRecording(track.id)}>
                    Stop Rec
                  </button>
                ) : (
                  <button onClick={() => startRecording(track.id)} disabled={Boolean(recordingTrackId)}>
                    Record
                  </button>
                )}
              </div>

              <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
                <div className="col" style={{ flex: 1 }}>
                  <small>Revision</small>
                  <select
                    value={sessionTracks[track.id]?.track_revision_id || ""}
                    onChange={(e) => patchSessionTrack(track.id, { track_revision_id: e.target.value || null })}
                  >
                    <option value="">No revision</option>
                    {revisions.map((r) => (
                      <option key={r.id} value={r.id}>
                        r{r.revision_number}
                      </option>
                    ))}
                  </select>
                </div>
                <label className="row" style={{ marginTop: 18 }}>
                  Mute
                  <input
                    type="checkbox"
                    checked={sessionTracks[track.id]?.mute || false}
                    onChange={(e) => patchSessionTrack(track.id, { mute: e.target.checked })}
                  />
                </label>
              </div>

              <div className="row" style={{ gap: 12 }}>
                <label className="col" style={{ flex: 1 }}>
                  Gain(dB)
                  <input
                    type="range"
                    min={-24}
                    max={12}
                    step={0.5}
                    value={sessionTracks[track.id]?.gain_db ?? 0}
                    onChange={(e) => patchSessionTrack(track.id, { gain_db: Number(e.target.value) })}
                  />
                </label>
                <label className="col" style={{ flex: 1 }}>
                  Pan
                  <input
                    type="range"
                    min={-1}
                    max={1}
                    step={0.01}
                    value={sessionTracks[track.id]?.pan ?? 0}
                    onChange={(e) => patchSessionTrack(track.id, { pan: Number(e.target.value) })}
                  />
                </label>
              </div>

              <small>
                {activeRevision
                  ? `assets: ${activeRevision.track_assets.map((a) => `${a.asset_type}:${a.status}`).join(" / ") || "-"}`
                  : "assets: -"}
              </small>
            </div>
          );
        })}
      </div>

      <div className="card col">
        <h2>Notes</h2>
        <form className="row" onSubmit={createNote}>
          <input value={newNote} onChange={(e) => setNewNote(e.target.value)} placeholder="memo" />
          <button type="submit">Add</button>
        </form>
        {notes.map((note) => (
          <div className="row" key={note.id} style={{ justifyContent: "space-between" }}>
            <span>{note.content}</span>
            <div className="row">
              <button onClick={() => editNote(note.id, note.content)}>Edit</button>
              <button className="danger" onClick={() => deleteNote(note.id)}>Delete</button>
            </div>
          </div>
        ))}
      </div>

      <div className="card col">
        <h2>Decisions</h2>
        <form className="col" onSubmit={createDecision}>
          <input value={newDecisionTitle} onChange={(e) => setNewDecisionTitle(e.target.value)} placeholder="title" />
          <textarea value={newDecisionText} onChange={(e) => setNewDecisionText(e.target.value)} placeholder="decision text" />
          <button type="submit">Add</button>
        </form>
        {decisions.map((d) => (
          <div className="card col" key={d.id} style={{ padding: 12 }}>
            <strong>{d.title}</strong>
            <p>{d.decision_text}</p>
            <div className="row">
              <button onClick={() => editDecision(d)}>Edit</button>
              <button className="danger" onClick={() => deleteDecision(d.id)}>Delete</button>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "none" }}>
        {sortedTracks.map((track) => (
          <audio
            key={track.id}
            ref={(el) => {
              audioRefs.current[track.id] = el;
            }}
            preload="auto"
          />
        ))}
      </div>

      {error && <small style={{ color: "#ff8080" }}>{error}</small>}
    </main>
  );
}

function displayRevisionNum(
  trackId: string,
  revisionId: string | null,
  revisionsByTrack: Record<string, Revision[]>
) {
  const list = revisionsByTrack[trackId] || [];
  const rev = list.find((x) => x.id === revisionId);
  return rev ? `r${rev.revision_number}` : "-";
}

function prevSessionTrack(trackId: string, tracks: Track[], sessionTracks: Record<string, MixSessionTrack>): MixSessionTrack {
  return (
    sessionTracks[trackId] ?? {
      track_id: trackId,
      track_revision_id: tracks.find((t) => t.id === trackId)?.active_revision_id ?? null,
      mute: false,
      gain_db: 0,
      pan: 0,
      start_offset_ms: 0
    }
  );
}
