import { describe, expect, it } from "bun:test";
import { isSensitivePath } from "./sensitive-path";

describe("sensitive path policy", () => {
	it("classifies common credential files while allowing templates", () => {
		expect(isSensitivePath(".env")).toBe(true);
		expect(isSensitivePath("config/.env.production")).toBe(true);
		expect(isSensitivePath("C:\\repo\\.env::$DATA")).toBe(true);
		expect(isSensitivePath("C:\\Users\\user\\.ssh\\id_ed25519")).toBe(true);
		expect(isSensitivePath("deploy/private.pem")).toBe(true);
		expect(isSensitivePath(".env.example")).toBe(false);
		expect(isSensitivePath("docs/environment.md")).toBe(false);
	});
});
