/**
 * Shared regex building blocks and predicates for classifying provider error
 * messages as auth-class failures.
 *
 * Two predicates with different scopes:
 *  - {@link isAuthErrorMessage} (broad) — used by the auto-retry path to
 *    decide whether a user-configured shell-out refresh could plausibly fix
 *    the error. Includes AWS SDK / SSO shapes plus generic 401/403 fallback.
 *  - {@link isOAuthDefinitiveFailure} (narrow) — used by `AuthStorage` to
 *    decide whether an OAuth refresh failure is severe enough to permanently
 *    disable the credential. Conservative: matches only OAuth-shaped errors.
 *
 * Both predicates share the same network-blip exclusion so transient
 * connectivity errors (`ECONNRESET`, fetch timeouts, etc.) never get
 * classified as auth failures.
 */

/** Errors that look like network/transport blips, never auth failures. */
export const NETWORK_BLIP_PATTERN =
	/timeout|timed out|network|fetch failed|ECONNREFUSED|ECONNRESET|EAI_AGAIN|socket hang up/i;

/** Bare 401/403 status codes; only meaningful when not also a network blip. */
export const HTTP_AUTH_STATUS_PATTERN = /\b(?:401|403)\b/;

/**
 * Broad auth-error pattern: OAuth refresh failures plus AWS SDK / SSO shapes
 * (`ExpiredToken`, `UnrecognizedClient`, `CredentialsProviderError`, "sso
 * session expired", "needs re-auth", etc.). Genuine validation errors
 * (`invalid_request`, `model_not_found`) are NOT matched.
 */
const BROAD_AUTH_PATTERN =
	/invalid_grant|invalid_token|token[^a-z0-9]+revoked|expired[^a-z0-9]+refresh|refresh[^a-z0-9]+expired|ExpiredToken|UnrecognizedClient|InvalidIdentityToken|ExpiredAccessToken|credentials[^a-z0-9]+(?:expired|invalid|missing|provider)|CredentialsProviderError|sso[^a-z0-9]+session[^a-z0-9]+(?:expired|invalid)|sso[^a-z0-9]+login[^a-z0-9]+required|credential[^a-z0-9]+(?:disabled|invalid|expired)|session[^a-z0-9]+has[^a-z0-9]+expired|needs?[^a-z0-9]+re-?auth|please[^a-z0-9]+re-?auth|re-?login[^a-z0-9]+required/i;

/** OAuth-specific subset; see `isOAuthDefinitiveFailure`. */
const OAUTH_AUTH_PATTERN = /invalid_grant|invalid_token|revoked|unauthorized|expired.*refresh|refresh.*expired/i;

/**
 * Does this provider error look like an authentication/credential failure
 * that a shell-out refresh could plausibly fix? Conservative on false
 * positives but covers the common upstream phrasings across providers.
 */
export function isAuthErrorMessage(errorMessage: string): boolean {
	if (!errorMessage) return false;
	if (BROAD_AUTH_PATTERN.test(errorMessage)) return true;
	if (HTTP_AUTH_STATUS_PATTERN.test(errorMessage) && !NETWORK_BLIP_PATTERN.test(errorMessage)) return true;
	return false;
}

/**
 * Does this OAuth refresh error indicate a definitive credential failure
 * (rotated, revoked, or invalid grant) versus a transient one? Used to
 * decide whether to permanently disable the credential.
 */
export function isOAuthDefinitiveFailure(errorMessage: string): boolean {
	if (!errorMessage) return false;
	if (OAUTH_AUTH_PATTERN.test(errorMessage)) return true;
	if (HTTP_AUTH_STATUS_PATTERN.test(errorMessage) && !NETWORK_BLIP_PATTERN.test(errorMessage)) return true;
	return false;
}
