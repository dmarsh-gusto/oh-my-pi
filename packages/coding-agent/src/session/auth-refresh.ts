import { isAuthErrorMessage } from "@oh-my-pi/pi-ai/auth-error-classification";
import { combineSignals } from "@oh-my-pi/pi-utils/ptree";
import { readLines } from "@oh-my-pi/pi-utils/stream";

// Re-exported here so callers in the retry path can import a single auth-
// refresh module. Source of truth lives in `pi-ai/auth-error-classification`,
// shared with `AuthStorage`'s OAuth-failure classifier.
export { isAuthErrorMessage };

/**
 * AuthRefreshRunner — coordinates a user-configured shell command that
 * refreshes provider credentials (e.g. AWS SSO login, OAuth helper).
 *
 * Used by the auto-retry path in `AgentSession` when an auth error is
 * surfaced and `retry.authRefresh.<provider>` (or `default`) is configured.
 *
 * Responsibilities:
 *  - Single-flight: concurrent refresh requests for the same command share a
 *    single in-flight promise, so a burst of in-flight requests that all hit
 *    the same expired credential triggers exactly one shell-out instead of N.
 *  - Hard timeout: long-running commands (typical: an SSO browser flow that
 *    the user never completes) are killed after `timeoutMs` and reported as
 *    timed-out so the caller can surface the original auth error.
 *  - Streaming output: stdout/stderr lines are reported through `onOutput`
 *    as they arrive so the caller can surface the SSO browser URL or other
 *    interactive guidance to the user without waiting for completion.
 *  - Cancellation: a caller-supplied `signal` (or session abort signal) ends
 *    the process tree promptly.
 *
 * The runner is intentionally provider-agnostic — the caller decides which
 * command to run, mirroring Claude Code's `awsAuthRefresh` semantics
 * generalized to any provider whose creds need a shell-out.
 */

/**
 * Bun.spawn-compatible options shape. We intentionally type only the fields
 * the runner uses so tests can inject a minimal fake without recreating the
 * whole Subprocess surface.
 */
export interface AuthRefreshSpawnOptions {
	stdout: "pipe";
	stderr: "pipe";
	stdin: "ignore";
	signal?: AbortSignal;
	cwd?: string;
}

export interface AuthRefreshSubprocess {
	readonly stdout: ReadableStream<Uint8Array> | null;
	readonly stderr: ReadableStream<Uint8Array> | null;
	readonly exited: Promise<number>;
	kill(signal?: number | NodeJS.Signals): void;
}

export type AuthRefreshSpawnFn = (cmd: string[], options: AuthRefreshSpawnOptions) => AuthRefreshSubprocess;

const defaultSpawn: AuthRefreshSpawnFn = (cmd, options) => {
	// Bun's Subprocess satisfies AuthRefreshSubprocess for the fields we use.
	return Bun.spawn(cmd, options) as unknown as AuthRefreshSubprocess;
};

export type AuthRefreshOutputStream = "stdout" | "stderr";

export interface AuthRefreshRequest {
	/** For logging only — single-flight dedupes on the command, not the provider id. */
	provider: string;
	/** Shell command line, run via `sh -c`. */
	command: string;
	/** Once exceeded, the child is killed and refresh resolves with `ok: false`. */
	timeoutMs: number;
	/** Each call is one full line, no trailing newline; never a partial chunk. */
	onOutput?: (line: string, stream: AuthRefreshOutputStream) => void;
	/** Independent of `timeoutMs` — either can fire. */
	signal?: AbortSignal;
	cwd?: string;
}

export type AuthRefreshOutcome =
	| { ok: true; durationMs: number }
	| { ok: false; reason: string; durationMs: number; exitCode?: number };

export interface AuthRefreshRunnerOptions {
	/** Override Bun.spawn for tests. */
	spawn?: AuthRefreshSpawnFn;
	/**
	 * Override the shell used to launch the command. Tests use this to point
	 * at a deterministic interpreter; defaults to `["sh", "-c"]`.
	 */
	shell?: readonly [string, string];
}

const DEFAULT_SHELL: readonly [string, string] = ["sh", "-c"];

/**
 * Coordinates auth-refresh shell-outs with single-flight semantics.
 *
 * Construction is lightweight (no I/O); a single instance can be reused for
 * the entire session lifetime.
 */
export class AuthRefreshRunner {
	#inFlight = new Map<string, Promise<AuthRefreshOutcome>>();
	#spawn: AuthRefreshSpawnFn;
	#shell: readonly [string, string];

	constructor(options: AuthRefreshRunnerOptions = {}) {
		this.#spawn = options.spawn ?? defaultSpawn;
		this.#shell = options.shell ?? DEFAULT_SHELL;
	}

	/**
	 * Run `request.command` (or join an in-flight run for the same command),
	 * streaming output to `request.onOutput` and returning the outcome once
	 * the child exits or the deadline elapses.
	 *
	 * Concurrent calls with the same `command` resolve to the same outcome —
	 * the second caller does NOT see a fresh shell-out. If callers pass
	 * different commands they get separate runs.
	 */
	async refresh(request: AuthRefreshRequest): Promise<AuthRefreshOutcome> {
		const key = request.command;
		const existing = this.#inFlight.get(key);
		if (existing) return existing;

		const promise = this.#runOnce(request).finally(() => {
			// Only clear the slot if it still points at this run — a new call
			// after we've started cleaning up should not be rejoined to ours.
			if (this.#inFlight.get(key) === promise) {
				this.#inFlight.delete(key);
			}
		});
		this.#inFlight.set(key, promise);
		return promise;
	}

	async #runOnce(request: AuthRefreshRequest): Promise<AuthRefreshOutcome> {
		const startedAt = performance.now();
		const elapsed = (): number => Math.round(performance.now() - startedAt);

		// Combine caller signal + timeout into one signal that fires on either.
		// `combineSignals` returns the parent signal directly when it's already
		// aborted, so the early-return below covers the pre-aborted case too.
		const combined = combineSignals(request.signal, request.timeoutMs);
		if (combined?.aborted) {
			return { ok: false, reason: "auth refresh aborted before launch", durationMs: elapsed() };
		}

		const [shellPath, shellFlag] = this.#shell;
		let child: AuthRefreshSubprocess;
		try {
			child = this.#spawn([shellPath, shellFlag, request.command], {
				stdout: "pipe",
				stderr: "pipe",
				stdin: "ignore",
				signal: combined,
				cwd: request.cwd,
			});
		} catch (err) {
			return {
				ok: false,
				reason: `failed to launch auth refresh: ${err instanceof Error ? err.message : String(err)}`,
				durationMs: elapsed(),
			};
		}

		const onOutput = request.onOutput;
		const stdoutPump = onOutput ? pumpStream(child.stdout, line => onOutput(line, "stdout")) : Promise.resolve();
		const stderrPump = onOutput ? pumpStream(child.stderr, line => onOutput(line, "stderr")) : Promise.resolve();

		let exitCode: number;
		try {
			exitCode = await child.exited;
		} catch (err) {
			// Drain pumps even on the rejection path so reader locks release
			// and any buffered output reaches `onOutput` before we return.
			await Promise.allSettled([stdoutPump, stderrPump]);
			return {
				ok: false,
				reason: `auth refresh process error: ${err instanceof Error ? err.message : String(err)}`,
				durationMs: elapsed(),
			};
		}

		// Drain remaining stdout/stderr so onOutput sees every line before we return.
		await Promise.allSettled([stdoutPump, stderrPump]);

		if (combined?.aborted) {
			const r = combined.reason;
			// AbortSignal.timeout aborts with a TimeoutError DOMException whose
			// runtime-dependent message may not include "timed out" — surface a
			// stable message here so callers and tests can match deterministically.
			const reason =
				r instanceof Error
					? r.name === "TimeoutError"
						? `auth refresh timed out after ${request.timeoutMs}ms`
						: r.message
					: String(r ?? "aborted");
			return { ok: false, reason, durationMs: elapsed(), exitCode };
		}

		if (exitCode !== 0) {
			return {
				ok: false,
				reason: `auth refresh exited with code ${exitCode}`,
				durationMs: elapsed(),
				exitCode,
			};
		}

		return { ok: true, durationMs: elapsed() };
	}
}

/**
 * Look up the configured refresh command for `provider`, falling back to the
 * record's `default` key. Returns `undefined` when neither is set, which the
 * caller treats as "auth-refresh not configured for this provider".
 */
export function selectAuthRefreshCommand(
	authRefresh: Record<string, string> | undefined,
	provider: string | undefined,
): string | undefined {
	if (!authRefresh) return undefined;
	if (provider) {
		const direct = authRefresh[provider];
		if (typeof direct === "string" && direct.trim().length > 0) return direct;
	}
	const fallback = authRefresh.default;
	if (typeof fallback === "string" && fallback.trim().length > 0) return fallback;
	return undefined;
}

async function pumpStream(stream: ReadableStream<Uint8Array> | null, onLine: (line: string) => void): Promise<void> {
	if (!stream) return;
	const decoder = new TextDecoder();
	for await (const bytes of readLines(stream)) {
		const text = decoder.decode(bytes);
		const stripped = text.endsWith("\r") ? text.slice(0, -1) : text;
		try {
			onLine(stripped);
		} catch {
			// onOutput must never break the pump — caller errors are their own problem.
		}
	}
}
