# X account operations

Read [channel execution](channel-execution.md). Use the `x` connection and the
`twitter` toolkit. These names refer to the same X account integration.

```sh
postplus channels tools list --toolkit twitter --limit 100 --json
postplus channels tools show TWITTER_USER_LOOKUP_ME --json
```

Reuse the user's own active connection and its already verified account identity.
When the task lacks a verified identity, use `TWITTER_USER_LOOKUP_ME` to confirm
the actual account ID and handle; do not add a new identity read before every
step when the same connection and identity remain established. Use the complete
current tool catalog and each tool's `show` schema for fields, scopes, pagination,
file inputs and platform restrictions. A connected account does not establish
permission for every endpoint. Distinguish platform access, available balance,
and the permission to perform the user's specific action.

X execution consumes the selected workspace's existing PostPlus credits. Use
the server's current pricing and billing result, including the difference
between reserved and finalized credits. Tool discovery and connection
management do not charge X execution credits. A follow-up read, upload, status
query against X, or publication check is a separate platform action with its
own declared price; inspecting the original PostPlus operation receipt does
not execute the platform action again. Follow the common channel execution
rules for existing authorization, insufficient balance and unresolved billing.

## Read and manage accounts

| Task | Tools to discover and inspect |
| --- | --- |
| Identity and profile lookup | `TWITTER_USER_LOOKUP_ME`, `TWITTER_USER_LOOKUP_BY_USERNAME`, `TWITTER_GET_USER_BY_ID` |
| Posts, mentions and home timeline | `TWITTER_GET_USER_POSTS`, `TWITTER_GET_USER_MENTIONS`, `TWITTER_USER_HOME_TIMELINE_BY_USER_ID` |
| Search and counts | `TWITTER_RECENT_SEARCH`, `TWITTER_FULL_ARCHIVE_SEARCH`, `TWITTER_SEARCH_RECENT_COUNTS`, `TWITTER_SEARCH_FULL_ARCHIVE_COUNTS`, `TWITTER_SEARCH_NEWS` |
| Post inspection and analytics | `TWITTER_POST_LOOKUP_BY_POST_ID`, `TWITTER_GET_POST_ANALYTICS`, `TWITTER_LIST_POST_LIKERS` |
| Lists, followers, bookmarks, likes, reposts, mute and block reads | Search the `twitter` catalog for the requested object or action; preserve its exact account/object IDs and pagination |
| Direct messages and conversations | `TWITTER_GET_RECENT_DM_EVENTS`, `TWITTER_LIST_CHAT_CONVERSATIONS`, `TWITTER_SEND_A_NEW_MESSAGE_TO_A_USER`, `TWITTER_SEND_DM_TO_CONVERSATION`, `TWITTER_CREATE_DM_CONVERSATION`, `TWITTER_DELETE_DM` |
| Spaces, activity subscriptions and compliance jobs | Inspect the matching catalog tool, required target, authentication and platform access before submitting |

For follow/unfollow, list changes, bookmarks, likes, reposts, reply moderation,
mute/unmute, deletion or a message, use the exact tool for the requested change
under the common authorization and single-submission procedure. Retrieval of
private messages requires the user's requested task and matching permissions.
Record account, time range, timezone, query and page coverage when interpreting
results. Inspect both returned data and any X `errors` array: a successful tool
receipt can contain partial object failures. Report those failures alongside the
usable data instead of claiming complete results. Enterprise-only stream access
does not establish a persistent PostPlus event listener; report exactly what the
selected tool returned.

## Publish, reply, quote and poll

For an approved text post, inspect `TWITTER_CREATION_OF_A_POST` and write:

<!-- tool-input: TWITTER_CREATION_OF_A_POST -->
```json
{"text":"<approved post>"}
```

```sh
postplus channels tools run TWITTER_CREATION_OF_A_POST --connection <own-x-connection-id> --input-file x-post.json --operation-id <stable-post-operation-id> --wait --json > x-post-result.json
```

This same tool supports replies through `reply_in_reply_to_tweet_id`, quotes
through `quote_tweet_id`, polls through `poll_options` and
`poll_duration_minutes`, and attached media through `media_media_ids`. Inspect
the selected combination in `show`; do not overwrite a quote, reply, audience or
visibility choice. Keep post and user IDs as strings. Use the actual returned
post ID with `TWITTER_POST_LOOKUP_BY_POST_ID` and compare its author, text and
media with the authorized request. Receipt success alone is not an independent
visibility check. This tool has no scheduled-post time field; a future posting
time requires an implemented scheduler rather than an invented argument.

## Images, GIFs and video

Upload the user's local file through `postplus media-file upload` and preserve
its complete returned media reference. Inspect `TWITTER_UPLOAD_MEDIA` for a small
image, or `TWITTER_UPLOAD_LARGE_MEDIA` for a GIF, video or larger image. Both have
the `media` file slot. Put the chosen non-media schema options in `x-upload.json`
(use `{}` when no options are needed). Put only the media mapping in
`x-media-map.json`:

```json
{"media":"<complete owned PostPlus media reference>"}
```

```sh
postplus channels tools run TWITTER_UPLOAD_LARGE_MEDIA --connection <own-x-connection-id> --input-file x-upload.json --media-map-file x-media-map.json --operation-id <stable-upload-operation-id> --wait --json > x-upload-result.json
```

The media map supplies `media`; do not also populate that field in the input or
hand-build a storage key. Select the schema's media category for the intended
post or message. Preserve the upload response and the actual numeric-string
media ID. For asynchronous processing, use `TWITTER_GET_MEDIA_UPLOAD_STATUS`
with `media_id` and inspect `processing_info` until processing succeeds or
fails. Do not attach pending or failed media. Media expires; prepare uploads
near publication and retain the returned expiry. Then pass the approved media
IDs to `TWITTER_CREATION_OF_A_POST` or the selected message tool and inspect the
resulting object independently. The low-level initialize/append tools use their
own schema-defined byte/base64 inputs; a file slot on one tool does not make
every media parameter a file slot.
