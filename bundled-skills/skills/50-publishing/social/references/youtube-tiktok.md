# YouTube and TikTok

Read [channel execution](channel-execution.md). Before uploading, confirm the
actual creator/channel, final title or caption, file rights, visibility,
category when needed, and whether the user asked for a draft or a live post.
These platforms may process video after a tool returns.

## YouTube local video

Use a `youtube` connection. `YOUTUBE_LIST_CHANNELS` finds channels available
to the connected account; select the intended one. Its own-channel input is:

<!-- tool-input: YOUTUBE_LIST_CHANNELS -->
```json
{"mine":true}
```

For a region-specific category, `YOUTUBE_LIST_VIDEO_CATEGORIES` accepts
`{"regionCode":"<actual two-letter country>"}`. Prepare the upload request
without an inline `videoFile` object:

```json
{"title":"<approved title>","description":"<approved description>","categoryId":"<valid category ID>","privacyStatus":"private"}
```

Upload the local file and use the returned media reference, not an invented
storage key:

```sh
postplus media-file upload --input-file ./video.mp4 --output media-result.json
postplus channels tools show YOUTUBE_MULTIPART_UPLOAD_VIDEO --json
postplus channels tools run YOUTUBE_MULTIPART_UPLOAD_VIDEO --connection <own-connection-id> --input-file youtube-upload.json --media-map-file youtube-map.json --operation-id <stable-operation-id> --wait --json > youtube-result.json
```

`youtube-map.json` has shape
`{"videoFile":"<output.mediaReference from media-result.json>"}`. Copy the
complete returned URI without adding another `postplus-media://` prefix. Set
`privacyStatus` to the user's authorized visibility, not automatically
`public`. Read the returned video ID with `YOUTUBE_GET_VIDEO_DETAILS_BATCH`
using `{"id":["<returned video ID>"],"parts":["snippet","status","processingDetails"]}`
only if these parts remain accepted by `show`. Confirm processing and privacy;
an upload response is not proof that the video is viewable.

## TikTok URL or file

Use a `tiktok` connection. `TIKTOK_QUERY_CREATOR_INFO` checks the creator and
its permitted visibility options. A platform-readable video URL follows
`TIKTOK_PUBLISH_VIDEO` with required `video_url` and `privacy_level`, plus
the approved `caption` if supplied:

<!-- tool-input: TIKTOK_PUBLISH_VIDEO -->
```json
{"video_url":"<accessible video URL>","privacy_level":"SELF_ONLY","caption":"<approved caption>"}
```

Choose the actual privacy value returned for the creator and authorized by
the user; `SELF_ONLY` above is an example, not an override. A local file uses
`TIKTOK_UPLOAD_VIDEO` instead. First `postplus media-file upload --input-file
./video.mp4 --output media-result.json`; put
`{"file_to_upload":"<output.mediaReference from media-result.json>"}` in the media-map
file and pass `--media-map-file`. Keep `file_to_upload` out of the request JSON;
put the user's caption, visibility and `publish` choice there as allowed by
`show`. Do not call URL publishing after file upload as though it were a
two-step protocol. Save the `publish_id`, then call
`TIKTOK_FETCH_PUBLISH_STATUS` with
`{"publish_id":"<returned publish ID>"}`. Distinguish submission,
processing, success, and actual visibility; current account eligibility may
block a route even when the catalog lists it.

```sh
postplus channels tools show TIKTOK_PUBLISH_VIDEO --json
postplus channels tools run TIKTOK_PUBLISH_VIDEO --connection <own-tiktok-connection-id> --input-file tiktok-url.json --operation-id <publish-operation-id> --wait --json > tiktok-submit-result.json
postplus channels tools show TIKTOK_FETCH_PUBLISH_STATUS --json
postplus channels tools run TIKTOK_FETCH_PUBLISH_STATUS --connection <own-tiktok-connection-id> --input-file tiktok-status.json --wait --json > tiktok-status-result.json
```
