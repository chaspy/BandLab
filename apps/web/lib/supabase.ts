import { createClient } from "@supabase/supabase-js";
import { WEB_CONFIG } from "./app-config";
import { createMockSupabaseClient, MOCK_AUTH_ENABLED } from "./mock";

export const supabase = MOCK_AUTH_ENABLED
  ? createMockSupabaseClient()
  : createClient(
      WEB_CONFIG.supabaseUrl,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "local-anon-key-placeholder"
    );
