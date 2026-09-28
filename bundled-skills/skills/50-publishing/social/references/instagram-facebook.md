# Instagram and Facebook Pages

Read [channel execution](channel-execution.md) first. Instagram media
containers and Facebook Page posts have different execution models. Confirm
the person's intended account, final content, image rights, and visibility
before writing. `channels tools show` supplies the live schema and deployment
gate for every named tool.

## Instagram: image post and reply

Use an `instagram` connection and `INSTAGRAM_GET_USER_INFO` to establish the
actual professional account ID; `ig_user_id` is an Instagram user ID, not a
Facebook Page ID. For a single image with a platform-readable JPEG URL,
prepare:

<!-- tool-input: INSTAGRAM_POST_IG_USER_MEDIA -->
```json
{"ig_user_id":"17841405309211844","image_url":"https://example.com/image.jpg","caption":"<approved caption>"}
```

The example ID and URL only satisfy the input shape; replace them with this
user's verified account and a real accessible image. `INSTAGRAM_POST_IG_USER_MEDIA`
creates a container. When `show` requires an
external target, bind `--target-id <IG user ID> --target-path ig_user_id`.
Capture the returned container ID. For eligible, processed content and the
authorized final post, prepare:

```sh
postplus channels tools show INSTAGRAM_POST_IG_USER_MEDIA --json
postplus channels tools run INSTAGRAM_POST_IG_USER_MEDIA --connection <own-instagram-connection-id> --target-id <actual-ig-user-id> --target-path ig_user_id --input-file ig-container.json --operation-id <container-operation-id> --wait --json > ig-container-result.json
```

<!-- tool-input: INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH -->
```json
{"ig_user_id":"<same IG user ID>","creation_id":"<returned container ID>"}
```

Run `INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH` as a separate write. Use
`INSTAGRAM_GET_IG_MEDIA` with `{"ig_media_id":"<returned media ID>"}`
to inspect the published object. Container creation alone is not a published
post. Reel and carousel child processing still require task-specific evidence;
do not automatically publish a just-created multi-item container. For a reply
to an actual comment, run `INSTAGRAM_POST_IG_COMMENT_REPLIES` with
`{"ig_comment_id":"<real comment ID>","message":"<approved reply>"}`,
then `INSTAGRAM_GET_IG_COMMENT_REPLIES` on that original comment or the
returned object as the schema permits. For performance, use
`INSTAGRAM_GET_IG_MEDIA_INSIGHTS` with the correct `ig_media_id` and
`metric` array selected from `show`; no universal metric list suits every
media type.

```sh
postplus channels tools show INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH --json
postplus channels tools run INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH --connection <own-instagram-connection-id> --target-id <actual-ig-user-id> --target-path ig_user_id --input-file ig-publish.json --operation-id <publish-operation-id> --wait --json > ig-publish-result.json
```

## Facebook: managed Page post and reply

Use a `facebook` connection. `FACEBOOK_LIST_MANAGED_PAGES` finds Pages the
connected account can manage; choose the exact Page and check required
permissions. A personal profile is not a Page. For a simple text post:

<!-- tool-input: FACEBOOK_CREATE_POST -->
```json
{"page_id":"<managed Page ID>","message":"<approved text>"}
```

Run `FACEBOOK_CREATE_POST`, binding `page_id` when `show` requires a target.
The response's post ID can be checked with `FACEBOOK_GET_POST` using
`{"post_id":"<returned post ID>"}`. For performance use
`FACEBOOK_GET_POST_INSIGHTS` on the same `post_id`, choosing metrics and period
from `show`. To answer a specific comment or post, inspect the actual parent
and use `FACEBOOK_CREATE_COMMENT` with
`{"object_id":"<actual post or comment ID>","message":"<approved reply>"}`;
`FACEBOOK_GET_COMMENT` can check a returned comment ID. `published:false`
and `scheduled_publish_time` are separate scheduling controls, so do not
infer a scheduled Page post from successful immediate publication. Review
schedule semantics and the resulting Page object before claiming that route.

```sh
postplus channels tools show FACEBOOK_CREATE_POST --json
postplus channels tools run FACEBOOK_CREATE_POST --connection <own-facebook-connection-id> --target-id <managed-page-id> --target-path page_id --input-file facebook-post.json --operation-id <post-operation-id> --wait --json > facebook-post-result.json
```
