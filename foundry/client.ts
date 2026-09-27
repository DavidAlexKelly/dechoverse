import { $ontologyRid } from "@ap-homepage/sdk";
import { type Client, type PlatformClient, createClient, createPlatformClient } from "@osdk/client";
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
 * - ontologies-read: executing the AI players' brain queries (dechoAgent*),
 *   which are ontology-scoped functions on the Accenture Ontology
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
  // Executing the AI players' brain queries through the generated OSDK.
  "api:ontologies-read",
];

export const auth: PublicOauthClient = createPublicOauthClient(clientId, foundryUrl, redirectUrl, {
  scopes,
});

/**
 * Initialize the client to interact with the Platform SDK.
 *
 * Filesystem browsing, streams, datasets and media sets are all Platform SDK.
 */
export const client: PlatformClient = createPlatformClient(foundryUrl, auth);

/**
 * The Ontology SDK client, for the AI players' brain queries.
 *
 * Queries are ontology-scoped: executeFunction goes to
 * /v2/ontologies/{ontology}/queries/{apiName}/execute, and the ontology is the
 * one @ap-homepage/sdk was generated against. Same sign-in as `client`.
 */
export const ontologyClient: Client = createClient(foundryUrl, $ontologyRid, auth);

export default client;
