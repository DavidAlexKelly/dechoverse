import { type PlatformClient, createPlatformClient } from "@osdk/client";
import { type PublicOauthClient, createPublicOauthClient } from "@osdk/oauth";

function getMetaTagContent(tagName: string): string {
  const elements = document.querySelectorAll(`meta[name="${tagName}"]`);
  const element = elements.item(elements.length - 1);
  const value = element ? element.getAttribute("content") : null;
  if (value == null || value === "") {
    throw new Error(`Meta tag ${tagName} not found or empty`);
  }
  if (value.match(/%.+%/)) {
    throw new Error(
      `Meta tag ${tagName} contains placeholder value. Please add ${value.replace(
        /%/g,
        "",
      )} to your .env files`,
    );
  }
  return value;
}

export const foundryUrl = getMetaTagContent("osdk-foundryUrl");
const clientId = getMetaTagContent("osdk-clientId");
const redirectUrl = getMetaTagContent("osdk-redirectUrl");

/**
 * Scopes requested at login. These must also be enabled on the application in
 * Developer Console, otherwise the OAuth redirect fails.
 *
 * - filesystem-read: browsing spaces, projects and folders
 * - streams-read/write: paint, tags and live player presence
 * - mediasets-read/write: tag images in the [AP] tags media set
 */
const scopes = [
  // Resolving the signed in user's name for their avatar label.
  "api:admin-read",
  // Reading the per-room snapshot files that let a room load without
  // replaying the whole mark stream.
  "api:datasets-read",
  "api:filesystem-read",
  "api:streams-read",
  "api:streams-write",
  "api:mediasets-read",
  "api:mediasets-write",
];

export const auth: PublicOauthClient = createPublicOauthClient(clientId, foundryUrl, redirectUrl, {
  scopes,
});

/**
 * Initialize the client to interact with the Platform SDK.
 *
 * Everything this app does — filesystem browsing, streams and media sets — is
 * Platform SDK, so no Ontology client is needed. If an Ontology SDK is added
 * later, follow the steps in
 * https://accenture.palantirfoundry.com/docs/foundry/ontology-sdk/add-osdk-to-bootstrapped-repository/
 */
export const client: PlatformClient = createPlatformClient(foundryUrl, auth);

export default client;
