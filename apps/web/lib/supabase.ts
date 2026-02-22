import { createClient } from "@supabase/supabase-js";
import { createMockSupabaseClient, MOCK_AUTH_ENABLED } from "./mock";

export const supabase = MOCK_AUTH_ENABLED
  ? createMockSupabaseClient()
  : createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "local-anon-key-placeholder"
    );
