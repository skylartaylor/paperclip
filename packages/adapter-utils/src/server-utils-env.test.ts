import { describe, expect, it } from "vitest";
import { sanitizeInheritedPaperclipEnv } from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });
  it("drops server-only credentials case-insensitively without mutating the parent environment", () => {
    const original = {
      DATABASE_URL: "database-canary", Database_Url: "mixed-database-canary",
      BETTER_AUTH_SECRET: "auth-canary", better_auth_secret: "mixed-auth-canary",
      Paperclip_Agent_Jwt_Secret: "mixed-paperclip-canary", paperclipai_cmd: "host-only-command",
      PAPERCLIP_AGENT_JWT_SECRET: "paperclip-canary",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100", HOME: "/home/agent", PATH: "/usr/bin",
    };
    expect(sanitizeInheritedPaperclipEnv(original)).toEqual({ PAPERCLIP_RUNTIME_API_URL: original.PAPERCLIP_RUNTIME_API_URL, HOME: original.HOME, PATH: original.PATH });
    expect(original.DATABASE_URL).toBe("database-canary");
  });

});
