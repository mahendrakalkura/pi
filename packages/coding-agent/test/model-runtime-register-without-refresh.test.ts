import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ProviderConfigInput } from "../src/core/provider-composer.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

const provider: ProviderConfigInput = {
	baseUrl: "https://provider.test/v1",
	apiKey: "test-key",
	api: "openai-completions",
	models: [
		{
			id: "demo-model",
			name: "Demo Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		},
	],
};

describe("ModelRuntime.registerWithoutRefresh", () => {
	it("registers at once and leaves the refresh to the caller", async () => {
		const runtime = getModelRuntime(await createInMemoryModelRegistry(new InMemoryCredentialStore()));
		const refresh = vi.spyOn(runtime, "refresh");

		runtime.registerWithoutRefresh(() => runtime.registerProvider("batched", provider));
		expect(refresh).not.toHaveBeenCalled();
		expect(runtime.getModel("batched", "demo-model")?.provider).toBe("batched");
		expect(runtime.hasConfiguredAuth("batched")).toBe(true);

		runtime.registerProvider("single", provider);
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("refreshes after registrations again once its callback throws", async () => {
		const runtime = getModelRuntime(await createInMemoryModelRegistry(new InMemoryCredentialStore()));
		const refresh = vi.spyOn(runtime, "refresh");

		expect(() =>
			runtime.registerWithoutRefresh(() => {
				throw new Error("registration failed");
			}),
		).toThrow("registration failed");
		runtime.registerProvider("single", provider);
		expect(refresh).toHaveBeenCalledTimes(1);
	});
});
