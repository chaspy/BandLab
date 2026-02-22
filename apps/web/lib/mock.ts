export const MOCK_API_ENABLED = process.env.NEXT_PUBLIC_USE_MOCK_API === "true";
export const MOCK_AUTH_ENABLED = process.env.NEXT_PUBLIC_USE_MOCK_AUTH === "true";

type MockUser = { id: string; email: string; password: string };
type MockBand = { id: string; name: string; invite_code: string; created_by: string; created_at: string };
type MockBandMember = { band_id: string; user_id: string; role: "member"; joined_at: string };
type MockSong = {
  id: string;
  band_id: string;
  title: string;
  bpm: number | null;
  musical_key: string | null;
  time_signature: string | null;
  description: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};
type MockTrack = {
  id: string;
  song_id: string;
  name: string;
  instrument_type: string | null;
  sort_order: number;
  active_revision_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};
type MockRevision = {
  id: string;
  track_id: string;
  revision_number: number;
  title: string | null;
  memo: string | null;
  created_by: string;
  created_at: string;
};
type MockAsset = {
  id: string;
  track_revision_id: string;
  asset_type: "audio_preview" | "audio_source" | "midi";
  format: string;
  status: "pending" | "uploaded" | "ready" | "failed";
  content_type: string;
  byte_size: number | null;
};
type MockMixSession = { id: string; song_id: string; name: string; created_by: string; created_at: string };
type MockMixSessionTrack = {
  mix_session_id: string;
  track_id: string;
  track_revision_id: string | null;
  mute: boolean;
  gain_db: number;
  pan: number;
  start_offset_ms: number;
};
type MockNote = {
  id: string;
  song_id: string;
  content: string;
  created_by: string;
  created_at: string;
  updated_at: string;
};
type MockDecision = {
  id: string;
  song_id: string;
  title: string;
  decision_text: string;
  reasoning: string | null;
  created_by: string;
  created_at: string;
};

type MockState = {
  users: MockUser[];
  bands: MockBand[];
  bandMembers: MockBandMember[];
  songs: MockSong[];
  tracks: MockTrack[];
  revisions: MockRevision[];
  assets: MockAsset[];
  mixSessions: MockMixSession[];
  mixSessionTracks: MockMixSessionTrack[];
  notes: MockNote[];
  decisions: MockDecision[];
};

const DEFAULT_USER_EMAIL = "demo1@example.com";
const DEFAULT_PASSWORD = "password123";
const MOCK_USER_KEY = "bandlab.mock.user";

const state: MockState = {
  users: [],
  bands: [],
  bandMembers: [],
  songs: [],
  tracks: [],
  revisions: [],
  assets: [],
  mixSessions: [],
  mixSessionTracks: [],
  notes: [],
  decisions: []
};

const assetObjectUrls = new Map<string, string>();

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return crypto.randomUUID();
}

function ensureSeedUser() {
  if (state.users.find((u) => u.email === DEFAULT_USER_EMAIL)) return;
  state.users.push({
    id: newId(),
    email: DEFAULT_USER_EMAIL,
    password: DEFAULT_PASSWORD
  });
}

function getStoredUserId() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(MOCK_USER_KEY) || "";
}

function setStoredUserId(userId: string) {
  if (typeof window === "undefined") return;
  if (userId) {
    window.localStorage.setItem(MOCK_USER_KEY, userId);
    return;
  }
  window.localStorage.removeItem(MOCK_USER_KEY);
}

function getCurrentUser() {
  ensureSeedUser();
  const userId = getStoredUserId();
  return state.users.find((u) => u.id === userId) ?? null;
}

function requireUser() {
  const user = getCurrentUser();
  if (!user) throw new Error("未ログインです");
  return user;
}

function parseJsonBody(init?: RequestInit) {
  if (!init?.body) return {};
  if (typeof init.body === "string") return JSON.parse(init.body);
  return {};
}

function assertBandMember(bandId: string, userId: string) {
  const isMember = state.bandMembers.some((m) => m.band_id === bandId && m.user_id === userId);
  if (!isMember) throw new Error("Forbidden");
}

function buildTrackAssets(revisionId: string) {
  return state.assets
    .filter((a) => a.track_revision_id === revisionId)
    .map((a) => ({
      id: a.id,
      asset_type: a.asset_type,
      format: a.format,
      status: a.status
    }));
}

function latestRevisionId(trackId: string): string | null {
  const revisions = state.revisions.filter((r) => r.track_id === trackId);
  if (revisions.length === 0) return null;
  return revisions.sort((a, b) => b.revision_number - a.revision_number)[0].id;
}

function toSessionTrack(trackId: string, trackRevisionId: string | null): Omit<MockMixSessionTrack, "mix_session_id"> {
  return {
    track_id: trackId,
    track_revision_id: trackRevisionId,
    mute: false,
    gain_db: 0,
    pan: 0,
    start_offset_ms: 0
  };
}

function parsePath(path: string) {
  return path.split("?")[0];
}

export async function mockApiFetch<T>(path: string, init?: RequestInit & { bandId?: string }): Promise<T> {
  const method = (init?.method || "GET").toUpperCase();
  const p = parsePath(path);
  const user = requireUser();

  if (p === "/api/me" && method === "GET") {
    const memberships = state.bandMembers.filter((m) => m.user_id === user.id);
    const bands = memberships
      .map((m) => {
        const band = state.bands.find((b) => b.id === m.band_id);
        if (!band) return null;
        return {
          id: band.id,
          name: band.name,
          invite_code: band.invite_code,
          role: m.role
        };
      })
      .filter(Boolean);
    return { user: { id: user.id }, bands } as T;
  }

  if (p === "/api/bands" && method === "POST") {
    const body = parseJsonBody(init);
    const band: MockBand = {
      id: newId(),
      name: String(body.name || "My Band"),
      invite_code: Math.random().toString(36).slice(2, 8).toUpperCase(),
      created_by: user.id,
      created_at: nowIso()
    };
    state.bands.push(band);
    state.bandMembers.push({ band_id: band.id, user_id: user.id, role: "member", joined_at: nowIso() });
    return {
      band: { id: band.id, name: band.name, invite_code: band.invite_code, role: "member" },
      invite_code: band.invite_code
    } as T;
  }

  if (p === "/api/bands/join" && method === "POST") {
    const body = parseJsonBody(init);
    const inviteCode = String(body.invite_code || "");
    const band = state.bands.find((b) => b.invite_code === inviteCode);
    if (!band) throw new Error("Band not found");
    const exists = state.bandMembers.some((m) => m.band_id === band.id && m.user_id === user.id);
    if (!exists) {
      state.bandMembers.push({ band_id: band.id, user_id: user.id, role: "member", joined_at: nowIso() });
    }
    return { band: { id: band.id, name: band.name, invite_code: band.invite_code, role: "member" } } as T;
  }

  if (p === "/api/songs" && method === "GET") {
    const bandId = init?.bandId;
    if (!bandId) throw new Error("x-band-id is required");
    assertBandMember(bandId, user.id);
    return {
      songs: state.songs
        .filter((s) => s.band_id === bandId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
    } as T;
  }

  if (p === "/api/songs" && method === "POST") {
    const bandId = init?.bandId;
    if (!bandId) throw new Error("x-band-id is required");
    assertBandMember(bandId, user.id);
    const body = parseJsonBody(init);
    const song: MockSong = {
      id: newId(),
      band_id: bandId,
      title: String(body.title || "New Song"),
      bpm: body.bpm ?? null,
      musical_key: body.key ?? null,
      time_signature: body.time_signature ?? null,
      description: body.description ?? null,
      created_by: user.id,
      created_at: nowIso(),
      updated_at: nowIso()
    };
    state.songs.push(song);
    return { song } as T;
  }

  const songGet = p.match(/^\/api\/songs\/([^/]+)$/);
  if (songGet && method === "GET") {
    const song = state.songs.find((s) => s.id === songGet[1]);
    if (!song) throw new Error("Song not found");
    assertBandMember(song.band_id, user.id);
    return { song } as T;
  }

  const songTracks = p.match(/^\/api\/songs\/([^/]+)\/tracks$/);
  if (songTracks && method === "GET") {
    const songId = songTracks[1];
    const song = state.songs.find((s) => s.id === songId);
    if (!song) throw new Error("Song not found");
    assertBandMember(song.band_id, user.id);
    return {
      tracks: state.tracks.filter((t) => t.song_id === songId).sort((a, b) => a.sort_order - b.sort_order)
    } as T;
  }
  if (songTracks && method === "POST") {
    const songId = songTracks[1];
    const song = state.songs.find((s) => s.id === songId);
    if (!song) throw new Error("Song not found");
    assertBandMember(song.band_id, user.id);
    const body = parseJsonBody(init);
    const sortOrder = state.tracks.filter((t) => t.song_id === songId).length + 1;
    const track: MockTrack = {
      id: newId(),
      song_id: songId,
      name: String(body.name || "New Track"),
      instrument_type: body.instrument_type ?? null,
      sort_order: sortOrder,
      active_revision_id: null,
      created_by: user.id,
      created_at: nowIso(),
      updated_at: nowIso()
    };
    state.tracks.push(track);
    return { track } as T;
  }

  const revisions = p.match(/^\/api\/tracks\/([^/]+)\/revisions$/);
  if (revisions && method === "GET") {
    const trackId = revisions[1];
    const track = state.tracks.find((t) => t.id === trackId);
    if (!track) throw new Error("Track not found");
    const song = state.songs.find((s) => s.id === track.song_id);
    if (!song) throw new Error("Song not found");
    assertBandMember(song.band_id, user.id);

    return {
      revisions: state.revisions
        .filter((r) => r.track_id === trackId)
        .sort((a, b) => a.revision_number - b.revision_number)
        .map((r) => ({ ...r, track_assets: buildTrackAssets(r.id) }))
    } as T;
  }
  if (revisions && method === "POST") {
    const trackId = revisions[1];
    const track = state.tracks.find((t) => t.id === trackId);
    if (!track) throw new Error("Track not found");
    const song = state.songs.find((s) => s.id === track.song_id);
    if (!song) throw new Error("Song not found");
    assertBandMember(song.band_id, user.id);

    const body = parseJsonBody(init);
    const currentMax = state.revisions
      .filter((r) => r.track_id === trackId)
      .reduce((max, r) => Math.max(max, r.revision_number), 0);

    const revision: MockRevision = {
      id: newId(),
      track_id: trackId,
      revision_number: currentMax + 1,
      title: body.title ?? null,
      memo: body.memo ?? null,
      created_by: user.id,
      created_at: nowIso()
    };
    state.revisions.push(revision);

    if (!track.active_revision_id) {
      track.active_revision_id = revision.id;
      track.updated_at = nowIso();
    }

    return { revision: { ...revision, track_assets: [] } } as T;
  }

  const setActive = p.match(/^\/api\/tracks\/([^/]+)\/active$/);
  if (setActive && method === "POST") {
    const trackId = setActive[1];
    const track = state.tracks.find((t) => t.id === trackId);
    if (!track) throw new Error("Track not found");
    const song = state.songs.find((s) => s.id === track.song_id);
    if (!song) throw new Error("Song not found");
    assertBandMember(song.band_id, user.id);

    const body = parseJsonBody(init);
    const revisionId = String(body.track_revision_id || "");
    const revision = state.revisions.find((r) => r.id === revisionId && r.track_id === trackId);
    if (!revision) throw new Error("Revision not found");

    track.active_revision_id = revision.id;
    track.updated_at = nowIso();
    return { track } as T;
  }

  const presign = p.match(/^\/api\/revisions\/([^/]+)\/assets\/presign$/);
  if (presign && method === "POST") {
    const revisionId = presign[1];
    const revision = state.revisions.find((r) => r.id === revisionId);
    if (!revision) throw new Error("Revision not found");

    const body = parseJsonBody(init);
    const sameType = state.assets.find((a) => a.track_revision_id === revisionId && a.asset_type === body.asset_type);
    if (sameType) {
      sameType.status = "pending";
      return {
        asset_id: sameType.id,
        upload_url: `mock://upload/${sameType.id}`,
        required_headers: {}
      } as T;
    }

    const asset: MockAsset = {
      id: newId(),
      track_revision_id: revisionId,
      asset_type: body.asset_type,
      format: String(body.format || "mp3"),
      content_type: String(body.content_type || "application/octet-stream"),
      status: "pending",
      byte_size: body.byte_size ?? null
    };
    state.assets.push(asset);

    return {
      asset_id: asset.id,
      upload_url: `mock://upload/${asset.id}`,
      required_headers: {}
    } as T;
  }

  const complete = p.match(/^\/api\/assets\/([^/]+)\/complete$/);
  if (complete && method === "POST") {
    const asset = state.assets.find((a) => a.id === complete[1]);
    if (!asset) throw new Error("Asset not found");
    const body = parseJsonBody(init);
    asset.status = "ready";
    asset.byte_size = body.byte_size ?? asset.byte_size;
    return { asset } as T;
  }

  const songSessions = p.match(/^\/api\/songs\/([^/]+)\/sessions$/);
  if (songSessions && method === "GET") {
    const songId = songSessions[1];
    return { sessions: state.mixSessions.filter((s) => s.song_id === songId) } as T;
  }
  if (songSessions && method === "POST") {
    const songId = songSessions[1];
    const body = parseJsonBody(init);
    const session: MockMixSession = {
      id: newId(),
      song_id: songId,
      name: String(body.name || "Session"),
      created_by: user.id,
      created_at: nowIso()
    };
    state.mixSessions.push(session);

    const tracks = state.tracks.filter((t) => t.song_id === songId);
    const rows = tracks.map((track) => {
      const revisionId = body.base === "latest" ? latestRevisionId(track.id) : track.active_revision_id;
      return {
        ...toSessionTrack(track.id, revisionId),
        mix_session_id: session.id
      };
    });
    state.mixSessionTracks.push(...rows);

    return { session } as T;
  }

  const sessionGet = p.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionGet && method === "GET") {
    const sessionId = sessionGet[1];
    const session = state.mixSessions.find((s) => s.id === sessionId);
    if (!session) throw new Error("Session not found");
    const tracks = state.mixSessionTracks
      .filter((t) => t.mix_session_id === sessionId)
      .map((t) => ({
        track_id: t.track_id,
        track_revision_id: t.track_revision_id,
        mute: t.mute,
        gain_db: t.gain_db,
        pan: t.pan,
        start_offset_ms: t.start_offset_ms
      }));
    return { session: { ...session, tracks } } as T;
  }

  const sessionTracksPut = p.match(/^\/api\/sessions\/([^/]+)\/tracks$/);
  if (sessionTracksPut && method === "PUT") {
    const sessionId = sessionTracksPut[1];
    const session = state.mixSessions.find((s) => s.id === sessionId);
    if (!session) throw new Error("Session not found");

    const body = parseJsonBody(init);
    const tracks = Array.isArray(body.tracks) ? body.tracks : [];

    state.mixSessionTracks = state.mixSessionTracks.filter((t) => t.mix_session_id !== sessionId);
    state.mixSessionTracks.push(
      ...tracks.map((t: Omit<MockMixSessionTrack, "mix_session_id">) => ({
        mix_session_id: sessionId,
        track_id: t.track_id,
        track_revision_id: t.track_revision_id,
        mute: Boolean(t.mute),
        gain_db: Number(t.gain_db ?? 0),
        pan: Number(t.pan ?? 0),
        start_offset_ms: Number(t.start_offset_ms ?? 0)
      }))
    );

    return { ok: true } as T;
  }

  const songNotes = p.match(/^\/api\/songs\/([^/]+)\/notes$/);
  if (songNotes && method === "GET") {
    const songId = songNotes[1];
    return { notes: state.notes.filter((n) => n.song_id === songId) } as T;
  }
  if (songNotes && method === "POST") {
    const songId = songNotes[1];
    const body = parseJsonBody(init);
    const note: MockNote = {
      id: newId(),
      song_id: songId,
      content: String(body.content || ""),
      created_by: user.id,
      created_at: nowIso(),
      updated_at: nowIso()
    };
    state.notes.push(note);
    return { note } as T;
  }

  const noteMutate = p.match(/^\/api\/notes\/([^/]+)$/);
  if (noteMutate && method === "PATCH") {
    const noteId = noteMutate[1];
    const note = state.notes.find((n) => n.id === noteId);
    if (!note) throw new Error("Note not found");
    const body = parseJsonBody(init);
    note.content = String(body.content || note.content);
    note.updated_at = nowIso();
    return { note } as T;
  }
  if (noteMutate && method === "DELETE") {
    const noteId = noteMutate[1];
    state.notes = state.notes.filter((n) => n.id !== noteId);
    return { ok: true } as T;
  }

  const songDecisions = p.match(/^\/api\/songs\/([^/]+)\/decisions$/);
  if (songDecisions && method === "GET") {
    const songId = songDecisions[1];
    return { decisions: state.decisions.filter((d) => d.song_id === songId) } as T;
  }
  if (songDecisions && method === "POST") {
    const songId = songDecisions[1];
    const body = parseJsonBody(init);
    const decision: MockDecision = {
      id: newId(),
      song_id: songId,
      title: String(body.title || ""),
      decision_text: String(body.decision_text || ""),
      reasoning: body.reasoning ?? null,
      created_by: user.id,
      created_at: nowIso()
    };
    state.decisions.push(decision);
    return { decision } as T;
  }

  const decisionMutate = p.match(/^\/api\/decisions\/([^/]+)$/);
  if (decisionMutate && method === "PATCH") {
    const decisionId = decisionMutate[1];
    const decision = state.decisions.find((d) => d.id === decisionId);
    if (!decision) throw new Error("Decision not found");
    const body = parseJsonBody(init);
    decision.title = String(body.title || decision.title);
    decision.decision_text = String(body.decision_text || decision.decision_text);
    decision.reasoning = body.reasoning ?? decision.reasoning;
    return { decision } as T;
  }
  if (decisionMutate && method === "DELETE") {
    const decisionId = decisionMutate[1];
    state.decisions = state.decisions.filter((d) => d.id !== decisionId);
    return { ok: true } as T;
  }

  throw new Error(`Mock route not implemented: ${method} ${p}`);
}

export async function mockUploadAssetFile(assetId: string, file: File) {
  const asset = state.assets.find((a) => a.id === assetId);
  if (!asset) throw new Error("Asset not found");

  const previous = assetObjectUrls.get(assetId);
  if (previous) URL.revokeObjectURL(previous);

  const url = URL.createObjectURL(file);
  assetObjectUrls.set(assetId, url);
  asset.status = "uploaded";
  asset.byte_size = file.size;
}

export function getMockAssetStreamUrl(assetId: string) {
  return assetObjectUrls.get(assetId) || "";
}

export function createMockSupabaseClient() {
  return {
    auth: {
      async getSession() {
        const user = getCurrentUser();
        return {
          data: {
            session: user
              ? {
                  access_token: `mock-token-${user.id}`,
                  user: { id: user.id, email: user.email }
                }
              : null
          },
          error: null
        };
      },
      async signInWithPassword({ email, password }: { email: string; password: string }) {
        ensureSeedUser();
        const user = state.users.find((u) => u.email === email);
        if (!user || user.password !== password) {
          return { data: { session: null }, error: { message: "メールアドレスまたはパスワードが違います" } };
        }
        setStoredUserId(user.id);
        return {
          data: {
            session: { access_token: `mock-token-${user.id}`, user: { id: user.id, email: user.email } }
          },
          error: null
        };
      },
      async signUp({ email, password }: { email: string; password: string }) {
        ensureSeedUser();
        const exists = state.users.find((u) => u.email === email);
        if (exists) {
          return { data: { session: null }, error: { message: "既に存在するユーザーです" } };
        }
        const user: MockUser = { id: newId(), email, password };
        state.users.push(user);
        setStoredUserId(user.id);
        return {
          data: {
            session: { access_token: `mock-token-${user.id}`, user: { id: user.id, email: user.email } }
          },
          error: null
        };
      },
      async signOut() {
        setStoredUserId("");
        return { error: null };
      }
    }
  };
}
