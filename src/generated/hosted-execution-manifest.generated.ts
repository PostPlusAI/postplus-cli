// GENERATED from apps/web/lib/server/postplus-cli/hosted-execution-manifest.ts
// and packages/vibe_marketing/public-skill-metadata.json execution bindings.
// Do not edit by hand. Run `pnpm hosted-execution-manifest:sync` to regenerate.

export const HOSTED_EXECUTION_MANIFEST_SCHEMA_VERSION =
  'hosted-execution-manifest/v1' as const;

export const HOSTED_EXECUTION_MANIFESTS = {
  "audio-transcription": [
    {
      "skill": "audio-transcription",
      "mode": "cli-runner",
      "surface": "flags",
      "verb": "transcribe",
      "domain": "media",
      "capability": "media-generation",
      "endpointKeys": [
        "transcription"
      ],
      "effect": "spend",
      "endpoints": [
        {
          "endpointKey": "transcription",
          "fields": [
            {
              "name": "audio",
              "class": "intent",
              "flag": "--audio",
              "type": "media-url",
              "mediaKind": "audio",
              "required": true
            },
            {
              "name": "duration_seconds",
              "class": "intent",
              "flag": "--duration-seconds",
              "type": "number",
              "required": true
            },
            {
              "name": "task",
              "class": "default",
              "flag": "--task",
              "type": "string",
              "enumValues": [
                "transcribe",
                "translate"
              ],
              "default": "transcribe",
              "required": false
            },
            {
              "name": "language",
              "class": "default",
              "flag": "--language",
              "type": "string",
              "default": "auto",
              "required": false
            },
            {
              "name": "enable_timestamps",
              "class": "default",
              "flag": "--enable-timestamps",
              "type": "boolean",
              "default": false,
              "required": false
            },
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": false
            },
            {
              "name": "mediaSeconds",
              "class": "runner-managed",
              "flag": null,
              "type": "number",
              "required": false,
              "derivedFrom": "duration_seconds"
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        }
      ]
    }
  ],
  "facebook-research": [
    {
      "skill": "facebook-research",
      "mode": "cli-runner",
      "surface": "flags",
      "verb": "run",
      "domain": "research",
      "capability": "public-content-collection",
      "effect": "spend",
      "sources": [
        {
          "routeKey": "facebook-group-posts",
          "fields": [
            {
              "name": "urls",
              "class": "intent",
              "flag": "--url",
              "type": "string",
              "required": true,
              "description": "Public URL; repeat for more than one.",
              "repeatable": true,
              "format": "url"
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 50,
              "integer": true,
              "min": 1,
              "max": 200
            }
          ]
        },
        {
          "routeKey": "facebook-post-by-url",
          "fields": [
            {
              "name": "urls",
              "class": "intent",
              "flag": "--url",
              "type": "string",
              "required": true,
              "description": "Public URL; repeat for more than one.",
              "repeatable": true,
              "format": "url"
            }
          ]
        },
        {
          "routeKey": "facebook-profile-posts",
          "fields": [
            {
              "name": "urls",
              "class": "intent",
              "flag": "--url",
              "type": "string",
              "required": true,
              "description": "Public URL; repeat for more than one.",
              "repeatable": true,
              "format": "url"
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 50,
              "integer": true,
              "min": 1,
              "max": 200
            }
          ]
        }
      ]
    },
    {
      "skill": "facebook-research",
      "mode": "cli-runner",
      "surface": "flags",
      "verb": "run",
      "domain": "research",
      "capability": "hosted-collection",
      "effect": "spend",
      "collections": [
        {
          "routeKey": "facebook-ads-library",
          "fields": [
            {
              "name": "query",
              "class": "intent",
              "flag": "--query",
              "type": "string",
              "required": true,
              "description": "Public search phrase."
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 20,
              "integer": true,
              "min": 1,
              "max": 200
            },
            {
              "name": "country",
              "class": "default",
              "flag": "--country",
              "type": "string",
              "required": false,
              "description": "Two-letter market code.",
              "default": "US"
            },
            {
              "name": "status",
              "class": "default",
              "flag": "--status",
              "type": "string",
              "required": false,
              "description": "Ad activity status.",
              "default": "active",
              "enumValues": [
                "active",
                "inactive",
                "all"
              ]
            }
          ]
        },
        {
          "routeKey": "facebook-comments",
          "fields": [
            {
              "name": "urls",
              "class": "intent",
              "flag": "--url",
              "type": "string",
              "required": true,
              "description": "Public URL; repeat for more than one.",
              "repeatable": true,
              "format": "url"
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 20,
              "integer": true,
              "min": 1,
              "max": 200
            },
            {
              "name": "include_replies",
              "class": "default",
              "flag": "--include-replies",
              "type": "boolean",
              "required": false,
              "description": "Include nested public replies.",
              "default": false
            }
          ]
        },
        {
          "routeKey": "facebook-events",
          "fields": [
            {
              "name": "queries",
              "class": "intent",
              "flag": "--query",
              "type": "string",
              "required": false,
              "description": "Event search phrase; repeat for more than one.",
              "repeatable": true
            },
            {
              "name": "urls",
              "class": "intent",
              "flag": "--url",
              "type": "string",
              "required": false,
              "description": "Public event URL; repeat for more than one.",
              "repeatable": true,
              "format": "url"
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 20,
              "integer": true,
              "min": 1,
              "max": 200
            }
          ],
          "requiredAnyOf": [
            "queries",
            "urls"
          ]
        },
        {
          "routeKey": "facebook-groups",
          "fields": [
            {
              "name": "urls",
              "class": "intent",
              "flag": "--url",
              "type": "string",
              "required": true,
              "description": "Public URL; repeat for more than one.",
              "repeatable": true,
              "format": "url"
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 20,
              "integer": true,
              "min": 1,
              "max": 200
            },
            {
              "name": "query",
              "class": "intent",
              "flag": "--query",
              "type": "string",
              "required": false,
              "description": "Optional keyword within the group."
            }
          ]
        },
        {
          "routeKey": "facebook-marketplace",
          "fields": [
            {
              "name": "urls",
              "class": "intent",
              "flag": "--url",
              "type": "string",
              "required": true,
              "description": "Public URL; repeat for more than one.",
              "repeatable": true,
              "format": "url"
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 20,
              "integer": true,
              "min": 1,
              "max": 200
            }
          ]
        },
        {
          "routeKey": "facebook-pages",
          "fields": [
            {
              "name": "urls",
              "class": "intent",
              "flag": "--url",
              "type": "string",
              "required": true,
              "description": "Public URL; repeat for more than one.",
              "repeatable": true,
              "format": "url"
            }
          ]
        },
        {
          "routeKey": "facebook-posts",
          "fields": [
            {
              "name": "urls",
              "class": "intent",
              "flag": "--url",
              "type": "string",
              "required": true,
              "description": "Public URL; repeat for more than one.",
              "repeatable": true,
              "format": "url"
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 20,
              "integer": true,
              "min": 1,
              "max": 200
            }
          ]
        },
        {
          "routeKey": "facebook-reels",
          "fields": [
            {
              "name": "urls",
              "class": "intent",
              "flag": "--url",
              "type": "string",
              "required": true,
              "description": "Public URL; repeat for more than one.",
              "repeatable": true,
              "format": "url"
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 20,
              "integer": true,
              "min": 1,
              "max": 200
            }
          ]
        },
        {
          "routeKey": "facebook-search",
          "fields": [
            {
              "name": "categories",
              "class": "intent",
              "flag": "--category",
              "type": "string",
              "required": true,
              "description": "Search category; repeat for more than one.",
              "repeatable": true
            },
            {
              "name": "locations",
              "class": "intent",
              "flag": "--location",
              "type": "string",
              "required": false,
              "description": "Search location; repeat for more than one.",
              "repeatable": true
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 20,
              "integer": true,
              "min": 1,
              "max": 200
            }
          ]
        }
      ]
    }
  ],
  "google-trends-research": [
    {
      "skill": "google-trends-research",
      "mode": "cli-runner",
      "surface": "flags",
      "verb": "run",
      "domain": "research",
      "capability": "hosted-collection",
      "effect": "spend",
      "collections": [
        {
          "routeKey": "google-trends-fast",
          "fields": [
            {
              "name": "query",
              "class": "intent",
              "flag": "--query",
              "type": "string",
              "required": true,
              "description": "Public search phrase."
            },
            {
              "name": "country",
              "class": "default",
              "flag": "--country",
              "type": "string",
              "required": false,
              "description": "Two-letter market code.",
              "default": "US"
            },
            {
              "name": "time_range",
              "class": "default",
              "flag": "--time-range",
              "type": "string",
              "required": false,
              "description": "Trend time window, for example today 12-m.",
              "default": "today 12-m"
            }
          ]
        }
      ]
    }
  ],
  "image-batch-runner": [
    {
      "skill": "image-batch-runner",
      "mode": "cli-runner",
      "surface": "flags",
      "verb": "create",
      "domain": "media",
      "capability": "media-generation",
      "endpointKeys": [
        "image-gpt-image-2-text",
        "image-gpt-image-2-edit",
        "image-nano-banana-2-text",
        "image-nano-banana-2-edit",
        "image-nano-banana-pro-text-1k",
        "image-nano-banana-pro-text-2k",
        "image-nano-banana-pro-text-4k",
        "image-nano-banana-pro-edit-1k",
        "image-nano-banana-pro-edit-2k",
        "image-nano-banana-pro-edit-4k",
        "image-seedream-v5-lite-text",
        "image-seedream-v5-lite-sequential",
        "image-seedream-v5-lite-edit",
        "image-seedream-v5-lite-edit-sequential",
        "image-higgsfield-soul-text"
      ],
      "effect": "spend",
      "endpoints": [
        {
          "endpointKey": "image-gpt-image-2-text",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "aspect_ratio",
              "class": "default",
              "flag": "--aspect-ratio",
              "type": "string",
              "enumValues": [
                "1:1",
                "9:16",
                "16:9",
                "4:5",
                "5:4",
                "3:4",
                "4:3",
                "2:3",
                "3:2"
              ],
              "default": "1:1",
              "required": false
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "enumValues": [
                "1k",
                "2k",
                "4k"
              ],
              "canonicalize": "image-resolution-tier",
              "default": "1k",
              "required": false
            },
            {
              "name": "quality",
              "class": "default",
              "flag": "--quality",
              "type": "string",
              "enumValues": [
                "low",
                "medium",
                "high"
              ],
              "canonicalize": "lowercase",
              "default": "medium",
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "image-gpt-image-2-edit",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "images",
              "class": "intent",
              "flag": "--reference-image",
              "type": "media-url",
              "mediaKind": "image",
              "repeatable": true,
              "required": true
            },
            {
              "name": "aspect_ratio",
              "class": "default",
              "flag": "--aspect-ratio",
              "type": "string",
              "enumValues": [
                "1:1",
                "9:16",
                "16:9",
                "4:5",
                "5:4",
                "3:4",
                "4:3",
                "2:3",
                "3:2"
              ],
              "default": "1:1",
              "required": false
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "enumValues": [
                "1k",
                "2k",
                "4k"
              ],
              "canonicalize": "image-resolution-tier",
              "default": "1k",
              "required": false
            },
            {
              "name": "quality",
              "class": "default",
              "flag": "--quality",
              "type": "string",
              "enumValues": [
                "low",
                "medium",
                "high"
              ],
              "canonicalize": "lowercase",
              "default": "medium",
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "image-nano-banana-2-text",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "aspect_ratio",
              "class": "default",
              "flag": "--aspect-ratio",
              "type": "string",
              "enumValues": [
                "9:16",
                "16:9",
                "1:1",
                "4:5"
              ],
              "default": "1:1",
              "required": false
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "enumValues": [
                "0.5k",
                "1k",
                "2k",
                "4k"
              ],
              "canonicalize": "image-resolution-tier",
              "default": "1k",
              "required": false
            },
            {
              "name": "output_format",
              "class": "default",
              "flag": "--output-format",
              "type": "string",
              "enumValues": [
                "png",
                "jpeg"
              ],
              "canonicalize": "lowercase",
              "default": "png",
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "image-nano-banana-2-edit",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "images",
              "class": "intent",
              "flag": "--reference-image",
              "type": "media-url",
              "mediaKind": "image",
              "repeatable": true,
              "required": true
            },
            {
              "name": "aspect_ratio",
              "class": "default",
              "flag": "--aspect-ratio",
              "type": "string",
              "enumValues": [
                "9:16",
                "16:9",
                "1:1",
                "4:5"
              ],
              "default": "1:1",
              "required": false
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "enumValues": [
                "0.5k",
                "1k",
                "2k",
                "4k"
              ],
              "canonicalize": "image-resolution-tier",
              "default": "1k",
              "required": false
            },
            {
              "name": "output_format",
              "class": "default",
              "flag": "--output-format",
              "type": "string",
              "enumValues": [
                "png",
                "jpeg"
              ],
              "canonicalize": "lowercase",
              "default": "png",
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "image-nano-banana-pro-text-1k",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "aspect_ratio",
              "class": "default",
              "flag": "--aspect-ratio",
              "type": "string",
              "enumValues": [
                "9:16",
                "16:9",
                "1:1",
                "4:5"
              ],
              "default": "1:1",
              "required": false
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "enumValues": [
                "1k"
              ],
              "canonicalize": "image-resolution-tier",
              "default": "1k",
              "required": false
            },
            {
              "name": "output_format",
              "class": "default",
              "flag": "--output-format",
              "type": "string",
              "enumValues": [
                "png",
                "jpeg"
              ],
              "canonicalize": "lowercase",
              "default": "png",
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "image-nano-banana-pro-text-2k",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "aspect_ratio",
              "class": "default",
              "flag": "--aspect-ratio",
              "type": "string",
              "enumValues": [
                "9:16",
                "16:9",
                "1:1",
                "4:5"
              ],
              "default": "1:1",
              "required": false
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "enumValues": [
                "2k"
              ],
              "canonicalize": "image-resolution-tier",
              "default": "2k",
              "required": false
            },
            {
              "name": "output_format",
              "class": "default",
              "flag": "--output-format",
              "type": "string",
              "enumValues": [
                "png",
                "jpeg"
              ],
              "canonicalize": "lowercase",
              "default": "png",
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "image-nano-banana-pro-text-4k",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "aspect_ratio",
              "class": "default",
              "flag": "--aspect-ratio",
              "type": "string",
              "enumValues": [
                "9:16",
                "16:9",
                "1:1",
                "4:5"
              ],
              "default": "1:1",
              "required": false
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "enumValues": [
                "4k"
              ],
              "canonicalize": "image-resolution-tier",
              "default": "4k",
              "required": false
            },
            {
              "name": "output_format",
              "class": "default",
              "flag": "--output-format",
              "type": "string",
              "enumValues": [
                "png",
                "jpeg"
              ],
              "canonicalize": "lowercase",
              "default": "png",
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "image-nano-banana-pro-edit-1k",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "images",
              "class": "intent",
              "flag": "--reference-image",
              "type": "media-url",
              "mediaKind": "image",
              "repeatable": true,
              "required": true
            },
            {
              "name": "aspect_ratio",
              "class": "intent",
              "flag": "--aspect-ratio",
              "type": "string",
              "enumValues": [
                "9:16",
                "16:9",
                "4:5"
              ],
              "required": false
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "enumValues": [
                "1k"
              ],
              "canonicalize": "image-resolution-tier",
              "default": "1k",
              "required": false
            },
            {
              "name": "output_format",
              "class": "default",
              "flag": "--output-format",
              "type": "string",
              "enumValues": [
                "png",
                "jpeg"
              ],
              "canonicalize": "lowercase",
              "default": "png",
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "image-nano-banana-pro-edit-2k",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "images",
              "class": "intent",
              "flag": "--reference-image",
              "type": "media-url",
              "mediaKind": "image",
              "repeatable": true,
              "required": true
            },
            {
              "name": "aspect_ratio",
              "class": "intent",
              "flag": "--aspect-ratio",
              "type": "string",
              "enumValues": [
                "9:16",
                "16:9",
                "4:5"
              ],
              "required": false
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "enumValues": [
                "2k"
              ],
              "canonicalize": "image-resolution-tier",
              "default": "2k",
              "required": false
            },
            {
              "name": "output_format",
              "class": "default",
              "flag": "--output-format",
              "type": "string",
              "enumValues": [
                "png",
                "jpeg"
              ],
              "canonicalize": "lowercase",
              "default": "png",
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "image-nano-banana-pro-edit-4k",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "images",
              "class": "intent",
              "flag": "--reference-image",
              "type": "media-url",
              "mediaKind": "image",
              "repeatable": true,
              "required": true
            },
            {
              "name": "aspect_ratio",
              "class": "intent",
              "flag": "--aspect-ratio",
              "type": "string",
              "enumValues": [
                "9:16",
                "16:9",
                "4:5"
              ],
              "required": false
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "enumValues": [
                "4k"
              ],
              "canonicalize": "image-resolution-tier",
              "default": "4k",
              "required": false
            },
            {
              "name": "output_format",
              "class": "default",
              "flag": "--output-format",
              "type": "string",
              "enumValues": [
                "png",
                "jpeg"
              ],
              "canonicalize": "lowercase",
              "default": "png",
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "image-seedream-v5-lite-text",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "size",
              "class": "default",
              "flag": "--size",
              "type": "string",
              "default": "1440*2560",
              "required": false
            },
            {
              "name": "output_format",
              "class": "default",
              "flag": "--output-format",
              "type": "string",
              "enumValues": [
                "jpeg",
                "png"
              ],
              "canonicalize": "lowercase",
              "default": "png",
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "image-seedream-v5-lite-sequential",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "size",
              "class": "default",
              "flag": "--size",
              "type": "string",
              "default": "1440*2560",
              "required": false
            },
            {
              "name": "output_format",
              "class": "default",
              "flag": "--output-format",
              "type": "string",
              "enumValues": [
                "jpeg",
                "png"
              ],
              "canonicalize": "lowercase",
              "default": "png",
              "required": false
            },
            {
              "name": "max_images",
              "class": "intent",
              "flag": "--max-images",
              "type": "number",
              "min": 1,
              "max": 15,
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "image-seedream-v5-lite-edit",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "images",
              "class": "intent",
              "flag": "--reference-image",
              "type": "media-url",
              "mediaKind": "image",
              "repeatable": true,
              "required": true
            },
            {
              "name": "size",
              "class": "default",
              "flag": "--size",
              "type": "string",
              "default": "1440*2560",
              "required": false
            },
            {
              "name": "output_format",
              "class": "default",
              "flag": "--output-format",
              "type": "string",
              "enumValues": [
                "jpeg",
                "png"
              ],
              "canonicalize": "lowercase",
              "default": "png",
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "image-seedream-v5-lite-edit-sequential",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "images",
              "class": "intent",
              "flag": "--reference-image",
              "type": "media-url",
              "mediaKind": "image",
              "repeatable": true,
              "required": true
            },
            {
              "name": "size",
              "class": "default",
              "flag": "--size",
              "type": "string",
              "default": "1440*2560",
              "required": false
            },
            {
              "name": "output_format",
              "class": "default",
              "flag": "--output-format",
              "type": "string",
              "enumValues": [
                "jpeg",
                "png"
              ],
              "canonicalize": "lowercase",
              "default": "png",
              "required": false
            },
            {
              "name": "max_images",
              "class": "intent",
              "flag": "--max-images",
              "type": "number",
              "min": 1,
              "max": 15,
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "image-higgsfield-soul-text",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "aspect_ratio",
              "class": "default",
              "flag": "--aspect-ratio",
              "type": "string",
              "enumValues": [
                "9:16",
                "16:9",
                "4:3",
                "3:4",
                "1:1",
                "2:3",
                "3:2"
              ],
              "default": "1:1",
              "required": false
            },
            {
              "name": "style_id",
              "class": "intent",
              "flag": "--style-id",
              "type": "string",
              "required": false
            },
            {
              "name": "style_strength",
              "class": "intent",
              "flag": "--style-strength",
              "type": "number",
              "required": false
            },
            {
              "name": "seed",
              "class": "intent",
              "flag": "--seed",
              "type": "number",
              "required": false
            },
            {
              "name": "enhance_prompt",
              "class": "intent",
              "flag": "--enhance-prompt",
              "type": "boolean",
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        }
      ]
    }
  ],
  "instagram-research": [
    {
      "skill": "instagram-research",
      "mode": "cli-runner",
      "surface": "flags",
      "verb": "run",
      "domain": "research",
      "capability": "hosted-collection",
      "effect": "spend",
      "collections": [
        {
          "routeKey": "instagram-comments",
          "fields": [
            {
              "name": "urls",
              "class": "intent",
              "flag": "--url",
              "type": "string",
              "required": true,
              "description": "Public URL; repeat for more than one.",
              "repeatable": true,
              "format": "url"
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 20,
              "integer": true,
              "min": 1,
              "max": 200
            },
            {
              "name": "include_replies",
              "class": "default",
              "flag": "--include-replies",
              "type": "boolean",
              "required": false,
              "description": "Include nested public replies.",
              "default": false
            }
          ]
        },
        {
          "routeKey": "instagram-email-search",
          "fields": [
            {
              "name": "handles",
              "class": "intent",
              "flag": "--handle",
              "type": "string",
              "required": true,
              "description": "Public account handle; repeat for more than one.",
              "repeatable": true
            }
          ]
        },
        {
          "routeKey": "instagram-hashtags",
          "fields": [
            {
              "name": "hashtags",
              "class": "intent",
              "flag": "--hashtag",
              "type": "string",
              "required": true,
              "description": "Hashtag without #; repeat for more than one.",
              "repeatable": true
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 20,
              "integer": true,
              "min": 1,
              "max": 200
            },
            {
              "name": "kind",
              "class": "default",
              "flag": "--kind",
              "type": "string",
              "required": false,
              "description": "Content type.",
              "default": "posts",
              "enumValues": [
                "posts",
                "reels",
                "stories"
              ]
            }
          ]
        },
        {
          "routeKey": "instagram-posts",
          "fields": [
            {
              "name": "handles",
              "class": "intent",
              "flag": "--handle",
              "type": "string",
              "required": true,
              "description": "Public account handle; repeat for more than one.",
              "repeatable": true
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 20,
              "integer": true,
              "min": 1,
              "max": 200
            }
          ]
        },
        {
          "routeKey": "instagram-profiles",
          "fields": [
            {
              "name": "handles",
              "class": "intent",
              "flag": "--handle",
              "type": "string",
              "required": true,
              "description": "Public account handle; repeat for more than one.",
              "repeatable": true
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 20,
              "integer": true,
              "min": 1,
              "max": 200
            }
          ]
        },
        {
          "routeKey": "instagram-search",
          "fields": [
            {
              "name": "queries",
              "class": "intent",
              "flag": "--query",
              "type": "string",
              "required": true,
              "description": "Public search phrase; repeat for more than one.",
              "repeatable": true
            },
            {
              "name": "kind",
              "class": "default",
              "flag": "--kind",
              "type": "string",
              "required": false,
              "description": "Search result type.",
              "default": "user",
              "enumValues": [
                "user",
                "hashtag",
                "place",
                "popular"
              ]
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 20,
              "integer": true,
              "min": 1,
              "max": 200
            }
          ]
        }
      ]
    }
  ],
  "pinterest-search": [
    {
      "skill": "pinterest-search",
      "mode": "cli-runner",
      "surface": "flags",
      "verb": "run",
      "domain": "research",
      "capability": "hosted-collection",
      "effect": "spend",
      "collections": [
        {
          "routeKey": "pinterest-search",
          "fields": [
            {
              "name": "query",
              "class": "intent",
              "flag": "--query",
              "type": "string",
              "required": true,
              "description": "Public search phrase."
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum pin count; service minimum is 20.",
              "default": 20,
              "integer": true,
              "min": 20,
              "max": 10000
            },
            {
              "name": "kind",
              "class": "default",
              "flag": "--kind",
              "type": "string",
              "required": false,
              "description": "Pin type filter.",
              "default": "all",
              "enumValues": [
                "all",
                "videos"
              ]
            }
          ]
        }
      ]
    }
  ],
  "reddit-search": [
    {
      "skill": "reddit-search",
      "mode": "cli-runner",
      "surface": "flags",
      "verb": "run",
      "domain": "research",
      "capability": "hosted-collection",
      "effect": "spend",
      "collections": [
        {
          "routeKey": "reddit-search",
          "fields": [
            {
              "name": "queries",
              "class": "intent",
              "flag": "--query",
              "type": "string",
              "required": false,
              "description": "Search phrase; repeat for more than one.",
              "repeatable": true
            },
            {
              "name": "urls",
              "class": "intent",
              "flag": "--url",
              "type": "string",
              "required": false,
              "description": "Public Reddit feed URL; repeat for more than one.",
              "repeatable": true,
              "format": "url"
            },
            {
              "name": "sort",
              "class": "default",
              "flag": "--sort",
              "type": "string",
              "required": false,
              "description": "Search ordering.",
              "default": "relevance",
              "enumValues": [
                "relevance",
                "hot",
                "top",
                "new",
                "comments"
              ]
            },
            {
              "name": "time_range",
              "class": "default",
              "flag": "--time-range",
              "type": "string",
              "required": false,
              "description": "Search time window.",
              "default": "year",
              "enumValues": [
                "hour",
                "day",
                "week",
                "month",
                "year",
                "all"
              ]
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum post count.",
              "default": 10,
              "integer": true,
              "min": 1,
              "max": 50000
            }
          ],
          "requiredAnyOf": [
            "queries",
            "urls"
          ]
        },
        {
          "routeKey": "reddit-post-comments",
          "fields": [
            {
              "name": "urls",
              "class": "intent",
              "flag": "--url",
              "type": "string",
              "required": true,
              "description": "Public URL; repeat for more than one.",
              "repeatable": true,
              "format": "url"
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum comments per post.",
              "default": 100,
              "integer": true,
              "min": 1,
              "max": 10000
            }
          ]
        },
        {
          "routeKey": "reddit-subreddit-posts",
          "fields": [
            {
              "name": "subreddits",
              "class": "intent",
              "flag": "--subreddit",
              "type": "string",
              "required": true,
              "description": "Subreddit name without r/; repeat for more than one.",
              "repeatable": true
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum post count.",
              "default": 100,
              "integer": true,
              "min": 1,
              "max": 50000
            },
            {
              "name": "posted_after",
              "class": "intent",
              "flag": "--posted-after",
              "type": "string",
              "required": false,
              "description": "Optional inclusive ISO date lower bound."
            }
          ]
        },
        {
          "routeKey": "reddit-user-activity",
          "fields": [
            {
              "name": "handles",
              "class": "intent",
              "flag": "--handle",
              "type": "string",
              "required": true,
              "description": "Reddit username; repeat for more than one.",
              "repeatable": true
            },
            {
              "name": "post_limit",
              "class": "default",
              "flag": "--post-limit",
              "type": "number",
              "required": false,
              "description": "Maximum posts per user.",
              "default": 25,
              "integer": true,
              "min": 0,
              "max": 50000
            },
            {
              "name": "comment_limit",
              "class": "default",
              "flag": "--comment-limit",
              "type": "number",
              "required": false,
              "description": "Maximum comments per user.",
              "default": 25,
              "integer": true,
              "min": 0,
              "max": 50000
            }
          ]
        }
      ]
    }
  ],
  "social-media-publisher": [
    {
      "skill": "social-media-publisher",
      "mode": "cli-runner",
      "surface": "request-json",
      "verb": "publish",
      "domain": "publish",
      "capability": "social-publishing",
      "operations": [
        {
          "operation": "analytics",
          "effect": "read"
        },
        {
          "operation": "channel-settings",
          "effect": "read"
        },
        {
          "operation": "create-post",
          "effect": "write"
        },
        {
          "operation": "delete-post",
          "effect": "write"
        },
        {
          "operation": "delete-post-group",
          "effect": "write"
        },
        {
          "operation": "list-channels",
          "effect": "read"
        },
        {
          "operation": "list-posts",
          "effect": "read"
        },
        {
          "operation": "missing-content",
          "effect": "read"
        },
        {
          "operation": "notifications",
          "effect": "read"
        },
        {
          "operation": "set-release-id",
          "effect": "write"
        },
        {
          "operation": "trigger-channel-tool",
          "effect": "write"
        },
        {
          "operation": "update-post-status",
          "effect": "write"
        },
        {
          "operation": "upload-file",
          "effect": "write"
        },
        {
          "operation": "upload-from-url",
          "effect": "write"
        }
      ]
    }
  ],
  "tiktok-research": [
    {
      "skill": "tiktok-research",
      "mode": "cli-runner",
      "surface": "flags",
      "verb": "run",
      "domain": "research",
      "capability": "hosted-collection",
      "effect": "spend",
      "collections": [
        {
          "routeKey": "tiktok-ads-top",
          "fields": [
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum ad count.",
              "default": 20,
              "integer": true,
              "min": 1,
              "max": 200
            }
          ]
        },
        {
          "routeKey": "tiktok-comments",
          "fields": [
            {
              "name": "urls",
              "class": "intent",
              "flag": "--url",
              "type": "string",
              "required": true,
              "description": "Public URL; repeat for more than one.",
              "repeatable": true,
              "format": "url"
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 20,
              "integer": true,
              "min": 1,
              "max": 200
            },
            {
              "name": "include_replies",
              "class": "default",
              "flag": "--include-replies",
              "type": "boolean",
              "required": false,
              "description": "Include comment replies.",
              "default": false
            }
          ]
        },
        {
          "routeKey": "tiktok-profiles",
          "fields": [
            {
              "name": "handles",
              "class": "intent",
              "flag": "--handle",
              "type": "string",
              "required": true,
              "description": "Public account handle; repeat for more than one.",
              "repeatable": true
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 20,
              "integer": true,
              "min": 1,
              "max": 200
            }
          ]
        },
        {
          "routeKey": "tiktok-related-videos",
          "fields": [
            {
              "name": "urls",
              "class": "intent",
              "flag": "--url",
              "type": "string",
              "required": true,
              "description": "Public URL; repeat for more than one.",
              "repeatable": true,
              "format": "url"
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 20,
              "integer": true,
              "min": 1,
              "max": 200
            },
            {
              "name": "country",
              "class": "default",
              "flag": "--country",
              "type": "string",
              "required": false,
              "description": "Two-letter market code.",
              "default": "US"
            }
          ]
        },
        {
          "routeKey": "tiktok-users",
          "fields": [
            {
              "name": "queries",
              "class": "intent",
              "flag": "--query",
              "type": "string",
              "required": true,
              "description": "Public search phrase; repeat for more than one.",
              "repeatable": true
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 20,
              "integer": true,
              "min": 1,
              "max": 200
            }
          ]
        },
        {
          "routeKey": "tiktok-videos",
          "fields": [
            {
              "name": "queries",
              "class": "intent",
              "flag": "--query",
              "type": "string",
              "required": false,
              "description": "Video search phrase; repeat for more than one.",
              "repeatable": true
            },
            {
              "name": "handles",
              "class": "intent",
              "flag": "--handle",
              "type": "string",
              "required": false,
              "description": "Creator handle; repeat for more than one.",
              "repeatable": true
            },
            {
              "name": "hashtags",
              "class": "intent",
              "flag": "--hashtag",
              "type": "string",
              "required": false,
              "description": "Hashtag without #; repeat for more than one.",
              "repeatable": true
            },
            {
              "name": "urls",
              "class": "intent",
              "flag": "--url",
              "type": "string",
              "required": false,
              "description": "Public video URL; repeat for more than one.",
              "repeatable": true,
              "format": "url"
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 20,
              "integer": true,
              "min": 1,
              "max": 200
            },
            {
              "name": "country",
              "class": "default",
              "flag": "--country",
              "type": "string",
              "required": false,
              "description": "Two-letter market code.",
              "default": "US"
            }
          ],
          "requiredAnyOf": [
            "queries",
            "handles",
            "hashtags",
            "urls"
          ]
        }
      ]
    }
  ],
  "video-analysis": [
    {
      "skill": "video-analysis",
      "mode": "cli-runner",
      "surface": "flags",
      "verb": "analyze",
      "domain": "media",
      "capability": "video-analysis",
      "modelKeys": [
        "video-analysis"
      ],
      "effect": "spend",
      "models": [
        {
          "modelKey": "video-analysis",
          "fields": [
            {
              "name": "video",
              "class": "intent",
              "flag": "--video",
              "type": "media-url",
              "mediaKind": "video",
              "required": true
            },
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            }
          ]
        }
      ]
    }
  ],
  "video-batch-runner": [
    {
      "skill": "video-batch-runner",
      "mode": "cli-runner",
      "surface": "flags",
      "verb": "create",
      "domain": "media",
      "capability": "media-generation",
      "endpointKeys": [
        "video-kling-v3-0-pro-text",
        "video-kling-v3-0-pro-image",
        "video-kling-v3-0-std-text",
        "video-kling-v3-0-std-image",
        "video-infinitetalk",
        "video-kling-v2-6-pro-motion-control",
        "video-seedance-2-5-text",
        "video-seedance-2-5-edit",
        "video-seedance-2-5-extend",
        "video-seedance-2-5-first-frame",
        "video-seedance-2-5-first-last-frame",
        "video-seedance-2-5-reference",
        "video-seedance-2-image",
        "video-seedance-2-text",
        "video-seedance-2-fast-image",
        "video-seedance-2-fast-text",
        "video-seedance-2-mini-image",
        "video-seedance-2-mini-text"
      ],
      "effect": "spend",
      "endpoints": [
        {
          "endpointKey": "video-kling-v3-0-pro-text",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "aspect_ratio",
              "class": "intent",
              "flag": "--aspect-ratio",
              "type": "string",
              "enumValues": [
                "16:9",
                "9:16",
                "1:1"
              ],
              "required": false
            },
            {
              "name": "duration",
              "class": "default",
              "flag": "--duration",
              "type": "number",
              "default": 5,
              "required": false,
              "min": 3,
              "max": 15
            },
            {
              "name": "sound",
              "class": "default",
              "flag": "--sound",
              "type": "boolean",
              "default": false,
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "requestDimensions",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "video-kling-v3-0-pro-image",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "image",
              "class": "intent",
              "flag": "--image",
              "type": "media-url",
              "mediaKind": "image",
              "required": true
            },
            {
              "name": "duration",
              "class": "default",
              "flag": "--duration",
              "type": "number",
              "default": 5,
              "required": false,
              "min": 3,
              "max": 15
            },
            {
              "name": "sound",
              "class": "default",
              "flag": "--sound",
              "type": "boolean",
              "default": false,
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "requestDimensions",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "video-kling-v3-0-std-text",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "aspect_ratio",
              "class": "intent",
              "flag": "--aspect-ratio",
              "type": "string",
              "enumValues": [
                "16:9",
                "9:16",
                "1:1"
              ],
              "required": false
            },
            {
              "name": "duration",
              "class": "default",
              "flag": "--duration",
              "type": "number",
              "default": 5,
              "required": false,
              "min": 3,
              "max": 15
            },
            {
              "name": "sound",
              "class": "default",
              "flag": "--sound",
              "type": "boolean",
              "default": false,
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "requestDimensions",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "video-kling-v3-0-std-image",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "image",
              "class": "intent",
              "flag": "--image",
              "type": "media-url",
              "mediaKind": "image",
              "required": true
            },
            {
              "name": "duration",
              "class": "default",
              "flag": "--duration",
              "type": "number",
              "default": 5,
              "required": false,
              "min": 3,
              "max": 15
            },
            {
              "name": "sound",
              "class": "default",
              "flag": "--sound",
              "type": "boolean",
              "default": false,
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "requestDimensions",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "video-infinitetalk",
          "fields": [
            {
              "name": "image",
              "class": "intent",
              "flag": "--image",
              "type": "media-url",
              "mediaKind": "image",
              "required": true
            },
            {
              "name": "audio",
              "class": "intent",
              "flag": "--audio",
              "type": "media-url",
              "mediaKind": "audio",
              "required": true
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "default": "720p",
              "required": false
            },
            {
              "name": "seed",
              "class": "intent",
              "flag": "--seed",
              "type": "number",
              "required": false
            },
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": false
            },
            {
              "name": "mask_image",
              "class": "intent",
              "flag": "--mask-image",
              "type": "media-url",
              "mediaKind": "image",
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "requestDimensions",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "video-kling-v2-6-pro-motion-control",
          "fields": [
            {
              "name": "image",
              "class": "intent",
              "flag": "--image",
              "type": "media-url",
              "mediaKind": "image",
              "required": true
            },
            {
              "name": "video",
              "class": "intent",
              "flag": "--video",
              "type": "media-url",
              "mediaKind": "video",
              "required": true
            },
            {
              "name": "character_orientation",
              "class": "intent",
              "flag": "--character-orientation",
              "type": "string",
              "required": true
            },
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": false
            },
            {
              "name": "negative_prompt",
              "class": "intent",
              "flag": "--negative-prompt",
              "type": "string",
              "required": false
            },
            {
              "name": "keep_original_sound",
              "class": "intent",
              "flag": "--keep-original-sound",
              "type": "boolean",
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "requestDimensions",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "video-seedance-2-5-text",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "enumValues": [
                "480p",
                "720p"
              ],
              "canonicalize": "lowercase",
              "default": "720p",
              "required": false
            },
            {
              "name": "aspect_ratio",
              "class": "default",
              "flag": "--aspect-ratio",
              "type": "string",
              "enumValues": [
                "adaptive",
                "21:9",
                "16:9",
                "4:3",
                "1:1",
                "3:4",
                "9:16"
              ],
              "default": "adaptive",
              "required": false
            },
            {
              "name": "duration",
              "class": "default",
              "flag": "--duration",
              "type": "number",
              "default": 5,
              "required": false,
              "min": 4,
              "max": 30,
              "specialValues": [
                -1
              ]
            },
            {
              "name": "generate_audio",
              "class": "default",
              "flag": "--generate-audio",
              "type": "boolean",
              "default": true,
              "required": false
            },
            {
              "name": "output_format",
              "class": "default",
              "flag": "--output-format",
              "type": "string",
              "enumValues": [
                "mp4",
                "mov"
              ],
              "canonicalize": "lowercase",
              "default": "mp4",
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "requestDimensions",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "video-seedance-2-5-edit",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "enumValues": [
                "480p",
                "720p"
              ],
              "canonicalize": "lowercase",
              "default": "720p",
              "required": false
            },
            {
              "name": "reference_images",
              "class": "intent",
              "flag": "--reference-image",
              "type": "media-url",
              "mediaKind": "image",
              "repeatable": true,
              "minItems": 1,
              "maxItems": 30,
              "required": false
            },
            {
              "name": "reference_videos",
              "class": "intent",
              "flag": "--reference-video",
              "type": "media-url",
              "mediaKind": "video",
              "repeatable": true,
              "minItems": 1,
              "maxItems": 10,
              "required": false
            },
            {
              "name": "reference_audios",
              "class": "intent",
              "flag": "--reference-audio",
              "type": "media-url",
              "mediaKind": "audio",
              "repeatable": true,
              "minItems": 1,
              "maxItems": 10,
              "required": false
            },
            {
              "name": "generate_audio",
              "class": "default",
              "flag": "--generate-audio",
              "type": "boolean",
              "default": true,
              "required": false
            },
            {
              "name": "output_format",
              "class": "default",
              "flag": "--output-format",
              "type": "string",
              "enumValues": [
                "mp4",
                "mov"
              ],
              "canonicalize": "lowercase",
              "default": "mp4",
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "requestDimensions",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "video-seedance-2-5-extend",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "enumValues": [
                "480p",
                "720p"
              ],
              "canonicalize": "lowercase",
              "default": "720p",
              "required": false
            },
            {
              "name": "reference_images",
              "class": "intent",
              "flag": "--reference-image",
              "type": "media-url",
              "mediaKind": "image",
              "repeatable": true,
              "minItems": 1,
              "maxItems": 30,
              "required": false
            },
            {
              "name": "reference_videos",
              "class": "intent",
              "flag": "--reference-video",
              "type": "media-url",
              "mediaKind": "video",
              "repeatable": true,
              "minItems": 1,
              "maxItems": 10,
              "required": false
            },
            {
              "name": "reference_audios",
              "class": "intent",
              "flag": "--reference-audio",
              "type": "media-url",
              "mediaKind": "audio",
              "repeatable": true,
              "minItems": 1,
              "maxItems": 10,
              "required": false
            },
            {
              "name": "generate_audio",
              "class": "default",
              "flag": "--generate-audio",
              "type": "boolean",
              "default": true,
              "required": false
            },
            {
              "name": "output_format",
              "class": "default",
              "flag": "--output-format",
              "type": "string",
              "enumValues": [
                "mp4",
                "mov"
              ],
              "canonicalize": "lowercase",
              "default": "mp4",
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "requestDimensions",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "video-seedance-2-5-first-frame",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "first_frame",
              "class": "intent",
              "flag": "--first-frame",
              "type": "media-url",
              "mediaKind": "image",
              "required": true
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "enumValues": [
                "480p",
                "720p"
              ],
              "canonicalize": "lowercase",
              "default": "720p",
              "required": false
            },
            {
              "name": "duration",
              "class": "default",
              "flag": "--duration",
              "type": "number",
              "default": 5,
              "required": false,
              "min": 4,
              "max": 30,
              "specialValues": [
                -1
              ]
            },
            {
              "name": "generate_audio",
              "class": "default",
              "flag": "--generate-audio",
              "type": "boolean",
              "default": true,
              "required": false
            },
            {
              "name": "output_format",
              "class": "default",
              "flag": "--output-format",
              "type": "string",
              "enumValues": [
                "mp4",
                "mov"
              ],
              "canonicalize": "lowercase",
              "default": "mp4",
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "requestDimensions",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "video-seedance-2-5-first-last-frame",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "first_frame",
              "class": "intent",
              "flag": "--first-frame",
              "type": "media-url",
              "mediaKind": "image",
              "required": true
            },
            {
              "name": "last_frame",
              "class": "intent",
              "flag": "--last-frame",
              "type": "media-url",
              "mediaKind": "image",
              "required": true
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "enumValues": [
                "480p",
                "720p"
              ],
              "canonicalize": "lowercase",
              "default": "720p",
              "required": false
            },
            {
              "name": "generate_audio",
              "class": "default",
              "flag": "--generate-audio",
              "type": "boolean",
              "default": true,
              "required": false
            },
            {
              "name": "output_format",
              "class": "default",
              "flag": "--output-format",
              "type": "string",
              "enumValues": [
                "mp4",
                "mov"
              ],
              "canonicalize": "lowercase",
              "default": "mp4",
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "requestDimensions",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "video-seedance-2-5-reference",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "enumValues": [
                "480p",
                "720p"
              ],
              "canonicalize": "lowercase",
              "default": "720p",
              "required": false
            },
            {
              "name": "aspect_ratio",
              "class": "default",
              "flag": "--aspect-ratio",
              "type": "string",
              "enumValues": [
                "adaptive",
                "21:9",
                "16:9",
                "4:3",
                "1:1",
                "3:4",
                "9:16"
              ],
              "default": "adaptive",
              "required": false
            },
            {
              "name": "duration",
              "class": "default",
              "flag": "--duration",
              "type": "number",
              "default": 5,
              "required": false,
              "min": 4,
              "max": 30,
              "specialValues": [
                -1
              ]
            },
            {
              "name": "reference_images",
              "class": "intent",
              "flag": "--reference-image",
              "type": "media-url",
              "mediaKind": "image",
              "repeatable": true,
              "minItems": 1,
              "maxItems": 30,
              "required": false
            },
            {
              "name": "reference_videos",
              "class": "intent",
              "flag": "--reference-video",
              "type": "media-url",
              "mediaKind": "video",
              "repeatable": true,
              "minItems": 1,
              "maxItems": 10,
              "required": false
            },
            {
              "name": "reference_audios",
              "class": "intent",
              "flag": "--reference-audio",
              "type": "media-url",
              "mediaKind": "audio",
              "repeatable": true,
              "minItems": 1,
              "maxItems": 10,
              "required": false
            },
            {
              "name": "generate_audio",
              "class": "default",
              "flag": "--generate-audio",
              "type": "boolean",
              "default": true,
              "required": false
            },
            {
              "name": "output_format",
              "class": "default",
              "flag": "--output-format",
              "type": "string",
              "enumValues": [
                "mp4",
                "mov"
              ],
              "canonicalize": "lowercase",
              "default": "mp4",
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "requestDimensions",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "video-seedance-2-image",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "image",
              "class": "intent",
              "flag": "--image",
              "type": "media-url",
              "mediaKind": "image",
              "required": true
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "enumValues": [
                "480p",
                "720p",
                "1080p"
              ],
              "canonicalize": "lowercase",
              "default": "720p",
              "required": false
            },
            {
              "name": "duration",
              "class": "default",
              "flag": "--duration",
              "type": "number",
              "default": 5,
              "required": false,
              "min": 4,
              "max": 15
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "requestDimensions",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "video-seedance-2-text",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "enumValues": [
                "480p",
                "720p",
                "1080p"
              ],
              "canonicalize": "lowercase",
              "default": "720p",
              "required": false
            },
            {
              "name": "aspect_ratio",
              "class": "intent",
              "flag": "--aspect-ratio",
              "type": "string",
              "enumValues": [
                "21:9",
                "16:9",
                "4:3",
                "1:1",
                "3:4",
                "9:16"
              ],
              "required": false
            },
            {
              "name": "duration",
              "class": "default",
              "flag": "--duration",
              "type": "number",
              "default": 5,
              "required": false,
              "min": 4,
              "max": 15
            },
            {
              "name": "reference_images",
              "class": "intent",
              "flag": "--reference-image",
              "type": "media-url",
              "mediaKind": "image",
              "repeatable": true,
              "minItems": 1,
              "maxItems": 9,
              "required": false
            },
            {
              "name": "reference_videos",
              "class": "intent",
              "flag": "--reference-video",
              "type": "media-url",
              "mediaKind": "video",
              "repeatable": true,
              "minItems": 1,
              "maxItems": 3,
              "required": false
            },
            {
              "name": "reference_audios",
              "class": "intent",
              "flag": "--reference-audio",
              "type": "media-url",
              "mediaKind": "audio",
              "repeatable": true,
              "minItems": 1,
              "maxItems": 3,
              "required": false
            },
            {
              "name": "generate_audio",
              "class": "default",
              "flag": "--generate-audio",
              "type": "boolean",
              "default": true,
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "requestDimensions",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "video-seedance-2-fast-image",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "image",
              "class": "intent",
              "flag": "--image",
              "type": "media-url",
              "mediaKind": "image",
              "required": true
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "enumValues": [
                "480p",
                "720p"
              ],
              "canonicalize": "lowercase",
              "default": "720p",
              "required": false
            },
            {
              "name": "duration",
              "class": "default",
              "flag": "--duration",
              "type": "number",
              "default": 5,
              "required": false,
              "min": 4,
              "max": 15
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "requestDimensions",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "video-seedance-2-fast-text",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "enumValues": [
                "480p",
                "720p"
              ],
              "canonicalize": "lowercase",
              "default": "720p",
              "required": false
            },
            {
              "name": "aspect_ratio",
              "class": "intent",
              "flag": "--aspect-ratio",
              "type": "string",
              "enumValues": [
                "21:9",
                "16:9",
                "4:3",
                "1:1",
                "3:4",
                "9:16"
              ],
              "required": false
            },
            {
              "name": "duration",
              "class": "default",
              "flag": "--duration",
              "type": "number",
              "default": 5,
              "required": false,
              "min": 4,
              "max": 15
            },
            {
              "name": "reference_images",
              "class": "intent",
              "flag": "--reference-image",
              "type": "media-url",
              "mediaKind": "image",
              "repeatable": true,
              "minItems": 1,
              "maxItems": 9,
              "required": false
            },
            {
              "name": "reference_videos",
              "class": "intent",
              "flag": "--reference-video",
              "type": "media-url",
              "mediaKind": "video",
              "repeatable": true,
              "minItems": 1,
              "maxItems": 3,
              "required": false
            },
            {
              "name": "reference_audios",
              "class": "intent",
              "flag": "--reference-audio",
              "type": "media-url",
              "mediaKind": "audio",
              "repeatable": true,
              "minItems": 1,
              "maxItems": 3,
              "required": false
            },
            {
              "name": "generate_audio",
              "class": "default",
              "flag": "--generate-audio",
              "type": "boolean",
              "default": true,
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "requestDimensions",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "video-seedance-2-mini-image",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "image",
              "class": "intent",
              "flag": "--image",
              "type": "media-url",
              "mediaKind": "image",
              "required": true
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "enumValues": [
                "480p",
                "720p"
              ],
              "canonicalize": "lowercase",
              "default": "720p",
              "required": false
            },
            {
              "name": "duration",
              "class": "default",
              "flag": "--duration",
              "type": "number",
              "default": 5,
              "required": false,
              "min": 4,
              "max": 15
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "requestDimensions",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "video-seedance-2-mini-text",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "enumValues": [
                "480p",
                "720p"
              ],
              "canonicalize": "lowercase",
              "default": "720p",
              "required": false
            },
            {
              "name": "aspect_ratio",
              "class": "intent",
              "flag": "--aspect-ratio",
              "type": "string",
              "enumValues": [
                "21:9",
                "16:9",
                "4:3",
                "1:1",
                "3:4",
                "9:16"
              ],
              "required": false
            },
            {
              "name": "duration",
              "class": "default",
              "flag": "--duration",
              "type": "number",
              "default": 5,
              "required": false,
              "min": 4,
              "max": 15
            },
            {
              "name": "reference_images",
              "class": "intent",
              "flag": "--reference-image",
              "type": "media-url",
              "mediaKind": "image",
              "repeatable": true,
              "minItems": 1,
              "maxItems": 9,
              "required": false
            },
            {
              "name": "generate_audio",
              "class": "default",
              "flag": "--generate-audio",
              "type": "boolean",
              "default": true,
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "requestDimensions",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        }
      ]
    }
  ],
  "video-transcription": [
    {
      "skill": "video-transcription",
      "mode": "cli-runner",
      "surface": "flags",
      "verb": "transcribe",
      "domain": "media",
      "capability": "media-generation",
      "endpointKeys": [
        "transcription-video"
      ],
      "effect": "spend",
      "endpoints": [
        {
          "endpointKey": "transcription-video",
          "fields": [
            {
              "name": "video",
              "class": "intent",
              "flag": "--video",
              "type": "media-url",
              "mediaKind": "video",
              "required": true
            },
            {
              "name": "duration_seconds",
              "class": "intent",
              "flag": "--duration-seconds",
              "type": "number",
              "required": true
            },
            {
              "name": "task",
              "class": "default",
              "flag": "--task",
              "type": "string",
              "enumValues": [
                "transcribe",
                "translate"
              ],
              "default": "transcribe",
              "required": false
            },
            {
              "name": "language",
              "class": "default",
              "flag": "--language",
              "type": "string",
              "default": "auto",
              "required": false
            },
            {
              "name": "enable_timestamps",
              "class": "default",
              "flag": "--enable-timestamps",
              "type": "boolean",
              "default": false,
              "required": false
            },
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": false
            },
            {
              "name": "mediaSeconds",
              "class": "runner-managed",
              "flag": null,
              "type": "number",
              "required": false,
              "derivedFrom": "duration_seconds"
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        }
      ]
    }
  ],
  "voice-batch-runner": [
    {
      "skill": "voice-batch-runner",
      "mode": "cli-runner",
      "surface": "flags",
      "verb": "create",
      "domain": "media",
      "capability": "media-generation",
      "endpointKeys": [
        "voice-design",
        "voice-clone"
      ],
      "effect": "spend",
      "endpoints": [
        {
          "endpointKey": "voice-design",
          "fields": [
            {
              "name": "text",
              "class": "intent",
              "flag": "--text",
              "type": "string",
              "required": true
            },
            {
              "name": "voice_description",
              "class": "intent",
              "flag": "--voice-description",
              "type": "string",
              "required": true
            },
            {
              "name": "language",
              "class": "default",
              "flag": "--language",
              "type": "string",
              "enumValues": [
                "auto",
                "Chinese",
                "English",
                "German",
                "Italian",
                "Portuguese",
                "Spanish",
                "Japanese",
                "Korean",
                "French",
                "Russian"
              ],
              "default": "auto",
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "requestDimensions",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        },
        {
          "endpointKey": "voice-clone",
          "fields": [
            {
              "name": "text",
              "class": "intent",
              "flag": "--text",
              "type": "string",
              "required": true
            },
            {
              "name": "audio",
              "class": "intent",
              "flag": "--audio",
              "type": "media-url",
              "mediaKind": "audio",
              "required": true
            },
            {
              "name": "reference_text",
              "class": "intent",
              "flag": "--reference-text",
              "type": "string",
              "required": false
            },
            {
              "name": "language",
              "class": "default",
              "flag": "--language",
              "type": "string",
              "enumValues": [
                "auto",
                "Chinese",
                "English",
                "German",
                "Italian",
                "Portuguese",
                "Spanish",
                "Japanese",
                "Korean",
                "French",
                "Russian"
              ],
              "default": "auto",
              "required": false
            },
            {
              "name": "operationId",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "quoteConfirmationToken",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "requestDimensions",
              "class": "runner-managed",
              "flag": null,
              "type": "string",
              "required": false
            }
          ]
        }
      ]
    }
  ],
  "x-research": [
    {
      "skill": "x-research",
      "mode": "cli-runner",
      "surface": "flags",
      "verb": "run",
      "domain": "research",
      "capability": "hosted-collection",
      "effect": "spend",
      "collections": [
        {
          "routeKey": "x-posts",
          "fields": [
            {
              "name": "queries",
              "class": "intent",
              "flag": "--query",
              "type": "string",
              "required": false,
              "description": "Public post search phrase; repeat for more than one.",
              "repeatable": true
            },
            {
              "name": "handles",
              "class": "intent",
              "flag": "--handle",
              "type": "string",
              "required": false,
              "description": "Account handle; repeat for more than one.",
              "repeatable": true
            },
            {
              "name": "urls",
              "class": "intent",
              "flag": "--url",
              "type": "string",
              "required": false,
              "description": "Public post or profile URL; repeat for more than one.",
              "repeatable": true,
              "format": "url"
            },
            {
              "name": "sort",
              "class": "default",
              "flag": "--sort",
              "type": "string",
              "required": false,
              "description": "Post ordering.",
              "default": "Latest",
              "enumValues": [
                "Latest",
                "Top"
              ]
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 20,
              "integer": true,
              "min": 1,
              "max": 200
            }
          ],
          "requiredAnyOf": [
            "queries",
            "handles",
            "urls"
          ]
        },
        {
          "routeKey": "x-profiles",
          "fields": [
            {
              "name": "handles",
              "class": "intent",
              "flag": "--handle",
              "type": "string",
              "required": true,
              "description": "Public account handle; repeat for more than one.",
              "repeatable": true
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 20,
              "integer": true,
              "min": 1,
              "max": 200
            }
          ]
        },
        {
          "routeKey": "x-user-search",
          "fields": [
            {
              "name": "queries",
              "class": "intent",
              "flag": "--query",
              "type": "string",
              "required": true,
              "description": "Public search phrase; repeat for more than one.",
              "repeatable": true
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 20,
              "integer": true,
              "min": 1,
              "max": 200
            }
          ]
        }
      ]
    }
  ],
  "youtube-research": [
    {
      "skill": "youtube-research",
      "mode": "cli-runner",
      "surface": "flags",
      "verb": "run",
      "domain": "research",
      "capability": "public-content-collection",
      "effect": "spend",
      "sources": [
        {
          "routeKey": "youtube-videos",
          "fields": [
            {
              "name": "urls",
              "class": "intent",
              "flag": "--url",
              "type": "string",
              "required": true,
              "description": "Public URL; repeat for more than one.",
              "repeatable": true,
              "format": "url"
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 50,
              "integer": true,
              "min": 1,
              "max": 200
            }
          ]
        }
      ]
    },
    {
      "skill": "youtube-research",
      "mode": "cli-runner",
      "surface": "flags",
      "verb": "run",
      "domain": "research",
      "capability": "hosted-collection",
      "effect": "spend",
      "collections": [
        {
          "routeKey": "youtube-channel-summary",
          "fields": [
            {
              "name": "channels",
              "class": "intent",
              "flag": "--channel",
              "type": "string",
              "required": true,
              "description": "Channel URL, ID, or @handle; repeat for more than one.",
              "repeatable": true
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum recent videos per channel.",
              "default": 20,
              "integer": true,
              "min": 0,
              "max": 200
            }
          ]
        },
        {
          "routeKey": "youtube-comments",
          "fields": [
            {
              "name": "urls",
              "class": "intent",
              "flag": "--url",
              "type": "string",
              "required": true,
              "description": "Public URL; repeat for more than one.",
              "repeatable": true,
              "format": "url"
            },
            {
              "name": "limit",
              "class": "default",
              "flag": "--limit",
              "type": "number",
              "required": false,
              "description": "Maximum result count.",
              "default": 20,
              "integer": true,
              "min": 1,
              "max": 200
            },
            {
              "name": "sort",
              "class": "default",
              "flag": "--sort",
              "type": "string",
              "required": false,
              "description": "Comment ordering.",
              "default": "top",
              "enumValues": [
                "top",
                "newest"
              ]
            },
            {
              "name": "include_replies",
              "class": "default",
              "flag": "--include-replies",
              "type": "boolean",
              "required": false,
              "description": "Include comment replies.",
              "default": true
            }
          ]
        },
        {
          "routeKey": "youtube-video-download",
          "fields": [
            {
              "name": "urls",
              "class": "intent",
              "flag": "--url",
              "type": "string",
              "required": true,
              "description": "Public URL; repeat for more than one.",
              "repeatable": true,
              "format": "url"
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": "--resolution",
              "type": "string",
              "required": false,
              "description": "Desired download resolution.",
              "default": "720p",
              "enumValues": [
                "360p",
                "480p",
                "720p",
                "1080p"
              ]
            }
          ]
        }
      ]
    }
  ]
} as const;
