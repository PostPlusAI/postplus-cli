# Discord: send to the intended channel

Use this reference for a connected Discord bot. It sends as the bot, not as a
human member. A server channel, group conversation, and direct message are
different destinations; identify the exact one requested. Check that the
target is appropriate for the audience and that the bot has permission. A
channel name alone is not an ID or proof of membership.

## Verify the destination and reply context

Use the `discord` connection and `discordbot` toolkit. Inspect each tool with
`postplus channels tools show <SLUG> --json`. If the user provided a channel
ID, query its metadata before sending:

<!-- tool-input: DISCORDBOT_GET_CHANNEL -->
```json
{"channel_id":"<CONFIRMED_CHANNEL_ID>"}
```

Run as `DISCORDBOT_GET_CHANNEL`. In CLI `output.result.data`, check `id`, `guild_id`, `name`,
and `type` against the requested destination. This tool does not return
messages or member lists. If the user wants a reply, run
`DISCORDBOT_GET_MESSAGE` first with the parent message ID in the *same*
channel:

<!-- tool-input: DISCORDBOT_GET_MESSAGE -->
```json
{"channel_id":"<CONFIRMED_CHANNEL_ID>","message_id":"<PARENT_MESSAGE_ID>"}
```

Confirm the parent content and author so a reply does not land under an
unrelated discussion. A missing or inaccessible parent is a stop, not a
reason to send a new top-level message.

## Send the requested text

For a plain notification, save this JSON as `discord-send.json`:

<!-- tool-input: DISCORDBOT_CREATE_MESSAGE -->
```json
{"channel_id":"<CONFIRMED_CHANNEL_ID>","content":"<APPROVED_TEXT>","allowed_mentions":{"parse":[]}}
```

Use `DISCORDBOT_CREATE_MESSAGE` with the selected connection. `content` is
limited to 2,000 characters. The empty `allowed_mentions.parse` prevents
incidental text from notifying everyone, roles, or users. If the user
specifically requests a notification mention, set the allowed IDs deliberately
after confirming them; do not add broad mentions by default.

For a reply, keep the same channel and add the verified parent ID:

<!-- tool-input: DISCORDBOT_CREATE_MESSAGE -->
```json
{"channel_id":"<CONFIRMED_CHANNEL_ID>","content":"<APPROVED_REPLY>","message_reference":{"message_id":"<PARENT_MESSAGE_ID>","fail_if_not_exists":true},"allowed_mentions":{"parse":[],"replied_user":false}}
```

Run and preserve the first response:

```sh
postplus channels tools run DISCORDBOT_CREATE_MESSAGE \
  --connection <DISCORD_CONNECTION_UUID> \
  --input-file discord-send.json \
  --operation-id <NEW_OPERATION_UUID> \
  --wait --json > discord-send-result.json
```

The initial tool data should include `id`, `channel_id`, `content`, and, for a
reply, `message_reference`. Compare them with the request. Then independently
run `DISCORDBOT_GET_MESSAGE` using `{"channel_id":"<SAME_CHANNEL_ID>",
"message_id":"<RETURNED_MESSAGE_ID>"}` and compare its content and location.
Readback proves the bot message exists there; it does not prove every member
read it. If the first result is unknown, check the original operation ID and
the intended channel before considering any further action; never blindly
resend.
