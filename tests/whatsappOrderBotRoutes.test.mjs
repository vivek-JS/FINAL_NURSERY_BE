import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("whatsapp order bot routes", () => {
  it("keeps debug and simulation endpoints behind admin auth", () => {
    const routeSource = readFileSync(
      resolve(process.cwd(), "routes/whatsappOrderBot.route.js"),
      "utf8"
    );

    assert.match(
      routeSource,
      /import \{ authenticateToken,\s*authorizeRoles \} from "\.\.\/middlewares\/auth\.middleware\.js";/
    );
    assert.match(
      routeSource,
      /const requireOrderBotAdmin = \[authenticateToken,\s*authorizeRoles\(\["SUPER_ADMIN",\s*"ADMIN"\]\)\];/
    );

    for (const [method, path] of [
      ["get", "/diagnostics"],
      ["get", "/test-wati-connectivity"],
      ["post", "/webhook-test"],
      ["post", "/start"],
      ["post", "/simulate-web"],
    ]) {
      assert.match(
        routeSource,
        new RegExp(`router\\.${method}\\("${path}",\\s*requireOrderBotAdmin,`)
      );
    }
  });
});
