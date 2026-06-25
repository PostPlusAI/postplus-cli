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
      "endpoints": [
        {
          "endpointKey": "transcription",
          "provider": "wavespeed",
          "providerModelPath": "wavespeed-ai/openai-whisper",
          "fields": [
            {
              "name": "audio",
              "class": "intent",
              "flag": "--audio",
              "type": "media-url",
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
          ],
          "billingDimensions": [
            "mediaSeconds"
          ]
        }
      ]
    }
  ],
  "facebook-research": [
    {
      "skill": "facebook-research",
      "mode": "cli-runner",
      "surface": "request-json",
      "verb": "scrape",
      "domain": "research",
      "capability": "public-content-collection",
      "sourceKeys": [
        "facebook-group-posts",
        "facebook-post-by-url",
        "facebook-profile-posts"
      ],
      "sources": [
        {
          "sourceKey": "facebook-group-posts",
          "datasetId": "gd_lz11l67o2cb3r0lkj3"
        },
        {
          "sourceKey": "facebook-post-by-url",
          "datasetId": "gd_lyclm1571iy3mv57zw"
        },
        {
          "sourceKey": "facebook-profile-posts",
          "datasetId": "gd_lkaxegm826bjpoo9m5"
        }
      ]
    }
  ],
  "google-trends-research": [
    {
      "skill": "google-trends-research",
      "mode": "cli-runner",
      "surface": "request-json",
      "verb": "collect",
      "domain": "research",
      "capability": "hosted-collection",
      "collectionKeys": [
        "google-trends-fast"
      ],
      "collections": [
        {
          "collectionKey": "google-trends-fast",
          "actorId": "google-trends-fast-scraper"
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
      "endpoints": [
        {
          "endpointKey": "image-gpt-image-2-text",
          "provider": "wavespeed",
          "providerModelPath": "openai/gpt-image-2/text-to-image",
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
              "default": "9:16",
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
          ],
          "billingDimensions": [
            "imageSize",
            "quality"
          ]
        },
        {
          "endpointKey": "image-gpt-image-2-edit",
          "provider": "wavespeed",
          "providerModelPath": "openai/gpt-image-2/edit",
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
              "repeatable": true,
              "required": true
            },
            {
              "name": "aspect_ratio",
              "class": "default",
              "flag": "--aspect-ratio",
              "type": "string",
              "default": "9:16",
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
          ],
          "billingDimensions": [
            "imageSize",
            "quality"
          ]
        },
        {
          "endpointKey": "image-nano-banana-2-text",
          "provider": "wavespeed",
          "providerModelPath": "google/nano-banana-2/text-to-image",
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
              "default": "9:16",
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
              "name": "enable_web_search",
              "class": "default",
              "flag": "--enable-web-search",
              "type": "boolean",
              "default": false,
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
          ],
          "billingDimensions": [
            "imageSize"
          ]
        },
        {
          "endpointKey": "image-nano-banana-2-edit",
          "provider": "wavespeed",
          "providerModelPath": "google/nano-banana-2/edit",
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
              "repeatable": true,
              "required": true
            },
            {
              "name": "aspect_ratio",
              "class": "default",
              "flag": "--aspect-ratio",
              "type": "string",
              "default": "9:16",
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
              "name": "enable_web_search",
              "class": "default",
              "flag": "--enable-web-search",
              "type": "boolean",
              "default": false,
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
          ],
          "billingDimensions": [
            "imageSize"
          ]
        },
        {
          "endpointKey": "image-nano-banana-pro-text-1k",
          "provider": "wavespeed",
          "providerModelPath": "google/nano-banana-pro/text-to-image",
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
              "default": "9:16",
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
          ],
          "billingDimensions": [
            "imageSize"
          ]
        },
        {
          "endpointKey": "image-nano-banana-pro-text-2k",
          "provider": "wavespeed",
          "providerModelPath": "google/nano-banana-pro/text-to-image",
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
              "default": "9:16",
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
          ],
          "billingDimensions": [
            "imageSize"
          ]
        },
        {
          "endpointKey": "image-nano-banana-pro-text-4k",
          "provider": "wavespeed",
          "providerModelPath": "google/nano-banana-pro/text-to-image",
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
              "default": "9:16",
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
          ],
          "billingDimensions": [
            "imageSize"
          ]
        },
        {
          "endpointKey": "image-nano-banana-pro-edit-1k",
          "provider": "wavespeed",
          "providerModelPath": "google/nano-banana-pro/edit",
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
              "repeatable": true,
              "required": true
            },
            {
              "name": "aspect_ratio",
              "class": "default",
              "flag": "--aspect-ratio",
              "type": "string",
              "default": "9:16",
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
          ],
          "billingDimensions": [
            "imageSize"
          ]
        },
        {
          "endpointKey": "image-nano-banana-pro-edit-2k",
          "provider": "wavespeed",
          "providerModelPath": "google/nano-banana-pro/edit",
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
              "repeatable": true,
              "required": true
            },
            {
              "name": "aspect_ratio",
              "class": "default",
              "flag": "--aspect-ratio",
              "type": "string",
              "default": "9:16",
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
          ],
          "billingDimensions": [
            "imageSize"
          ]
        },
        {
          "endpointKey": "image-nano-banana-pro-edit-4k",
          "provider": "wavespeed",
          "providerModelPath": "google/nano-banana-pro/edit",
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
              "repeatable": true,
              "required": true
            },
            {
              "name": "aspect_ratio",
              "class": "default",
              "flag": "--aspect-ratio",
              "type": "string",
              "default": "9:16",
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
          ],
          "billingDimensions": [
            "imageSize"
          ]
        },
        {
          "endpointKey": "image-seedream-v5-lite-text",
          "provider": "wavespeed",
          "providerModelPath": "bytedance/seedream-v5.0-lite",
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
          ],
          "billingDimensions": [
            "billableUnitCount"
          ]
        },
        {
          "endpointKey": "image-seedream-v5-lite-sequential",
          "provider": "wavespeed",
          "providerModelPath": "bytedance/seedream-v5.0-lite/sequential",
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
          ],
          "billingDimensions": [
            "billableUnitCount"
          ]
        },
        {
          "endpointKey": "image-seedream-v5-lite-edit",
          "provider": "wavespeed",
          "providerModelPath": "bytedance/seedream-v5.0-lite/edit",
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
          ],
          "billingDimensions": [
            "billableUnitCount"
          ]
        },
        {
          "endpointKey": "image-seedream-v5-lite-edit-sequential",
          "provider": "wavespeed",
          "providerModelPath": "bytedance/seedream-v5.0-lite/edit-sequential",
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
          ],
          "billingDimensions": [
            "billableUnitCount"
          ]
        },
        {
          "endpointKey": "image-higgsfield-soul-text",
          "provider": "higgsfield",
          "providerModelPath": "higgsfield-ai/soul/standard",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": "--prompt",
              "type": "string",
              "required": true
            },
            {
              "name": "width_and_height",
              "class": "intent",
              "flag": "--width-and-height",
              "type": "string",
              "required": true
            },
            {
              "name": "quality",
              "class": "default",
              "flag": "--quality",
              "type": "string",
              "enumValues": [
                "720p",
                "1080p"
              ],
              "canonicalize": "lowercase",
              "default": "720p",
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
          ],
          "billingDimensions": [
            "quality"
          ]
        }
      ]
    }
  ],
  "instagram-tools": [
    {
      "skill": "instagram-tools",
      "mode": "cli-runner",
      "surface": "request-json",
      "verb": "collect",
      "domain": "research",
      "capability": "hosted-collection",
      "collectionKeys": [
        "instagram-comments",
        "instagram-email-search",
        "instagram-hashtags",
        "instagram-posts",
        "instagram-profiles",
        "instagram-search"
      ],
      "collections": [
        {
          "collectionKey": "instagram-comments",
          "actorId": "apify/instagram-comment-scraper"
        },
        {
          "collectionKey": "instagram-email-search",
          "actorId": "bhansalisoft/instagram-email-scraper"
        },
        {
          "collectionKey": "instagram-hashtags",
          "actorId": "apify/instagram-hashtag-scraper"
        },
        {
          "collectionKey": "instagram-posts",
          "actorId": "apify/instagram-post-scraper"
        },
        {
          "collectionKey": "instagram-profiles",
          "actorId": "apify/instagram-profile-scraper"
        },
        {
          "collectionKey": "instagram-search",
          "actorId": "apify/instagram-search-scraper"
        }
      ]
    }
  ],
  "seedance-submitter": [
    {
      "skill": "seedance-submitter",
      "mode": "cli-runner",
      "surface": "request-json",
      "verb": "create",
      "domain": "media",
      "capability": "media-generation",
      "endpointKeys": [
        "video-seedance-2-image",
        "video-seedance-2-text"
      ],
      "endpoints": [
        {
          "endpointKey": "video-seedance-2-image",
          "provider": "wavespeed",
          "providerModelPath": "bytedance/seedance-2.0/image-to-video",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": null,
              "type": "string",
              "required": true
            },
            {
              "name": "image",
              "class": "intent",
              "flag": null,
              "type": "media-url",
              "required": true
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": null,
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
              "flag": null,
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
          ],
          "billingDimensions": [
            "duration",
            "resolution",
            "referenceVideoCount",
            "referenceVideoMode"
          ]
        },
        {
          "endpointKey": "video-seedance-2-text",
          "provider": "wavespeed",
          "providerModelPath": "bytedance/seedance-2.0/text-to-video",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": null,
              "type": "string",
              "required": true
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": null,
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
              "flag": null,
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
              "flag": null,
              "type": "number",
              "default": 5,
              "required": false,
              "min": 4,
              "max": 15
            },
            {
              "name": "reference_images",
              "class": "intent",
              "flag": null,
              "type": "media-url",
              "repeatable": true,
              "required": false
            },
            {
              "name": "reference_videos",
              "class": "intent",
              "flag": null,
              "type": "media-url",
              "repeatable": true,
              "required": false
            },
            {
              "name": "reference_audios",
              "class": "intent",
              "flag": null,
              "type": "media-url",
              "repeatable": true,
              "required": false
            },
            {
              "name": "enable_web_search",
              "class": "default",
              "flag": null,
              "type": "boolean",
              "default": false,
              "required": false
            },
            {
              "name": "generate_audio",
              "class": "default",
              "flag": null,
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
          ],
          "billingDimensions": [
            "duration",
            "resolution",
            "referenceVideoCount",
            "referenceVideoMode"
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
          "operation": "analytics"
        },
        {
          "operation": "channel-settings"
        },
        {
          "operation": "create-post"
        },
        {
          "operation": "delete-post"
        },
        {
          "operation": "delete-post-group"
        },
        {
          "operation": "list-channels"
        },
        {
          "operation": "list-posts"
        },
        {
          "operation": "missing-content"
        },
        {
          "operation": "notifications"
        },
        {
          "operation": "set-release-id"
        },
        {
          "operation": "trigger-channel-tool"
        },
        {
          "operation": "update-post-status"
        },
        {
          "operation": "upload-file"
        },
        {
          "operation": "upload-from-url"
        }
      ]
    }
  ],
  "tiktok-ad-research": [
    {
      "skill": "tiktok-ad-research",
      "mode": "cli-runner",
      "surface": "request-json",
      "verb": "collect",
      "domain": "research",
      "capability": "hosted-collection",
      "collectionKeys": [
        "tiktok-ads-top"
      ],
      "collections": [
        {
          "collectionKey": "tiktok-ads-top",
          "actorId": "tiktok-creative-center-top-ads"
        }
      ]
    }
  ],
  "tiktok-research": [
    {
      "skill": "tiktok-research",
      "mode": "cli-runner",
      "surface": "request-json",
      "verb": "collect",
      "domain": "research",
      "capability": "hosted-collection",
      "collectionKeys": [
        "tiktok-comments",
        "tiktok-profiles",
        "tiktok-related-videos",
        "tiktok-users",
        "tiktok-videos"
      ],
      "collections": [
        {
          "collectionKey": "tiktok-comments",
          "actorId": "clockworks/tiktok-comments-scraper"
        },
        {
          "collectionKey": "tiktok-profiles",
          "actorId": "clockworks/tiktok-profile-scraper"
        },
        {
          "collectionKey": "tiktok-related-videos",
          "actorId": "clockworks/tiktok-scraper"
        },
        {
          "collectionKey": "tiktok-users",
          "actorId": "clockworks/tiktok-user-search-scraper"
        },
        {
          "collectionKey": "tiktok-videos",
          "actorId": "clockworks/tiktok-scraper"
        }
      ]
    }
  ],
  "video-analysis": [
    {
      "skill": "video-analysis",
      "mode": "cli-runner",
      "surface": "request-json",
      "verb": "analyze",
      "domain": "media",
      "capability": "video-analysis",
      "modelKeys": [
        "video-analysis"
      ],
      "models": [
        {
          "modelKey": "video-analysis",
          "providerModelPath": "gemini-3.5-flash"
        }
      ]
    }
  ],
  "video-batch-runner": [
    {
      "skill": "video-batch-runner",
      "mode": "cli-runner",
      "surface": "request-json",
      "verb": "create",
      "domain": "media",
      "capability": "media-generation",
      "endpointKeys": [
        "video-kling-v3-0-pro-text",
        "video-kling-v3-0-pro-image",
        "video-kling-v3-0-std-text",
        "video-kling-v3-0-std-image",
        "video-infinitetalk",
        "video-kling-v2-6-pro-motion-control"
      ],
      "endpoints": [
        {
          "endpointKey": "video-kling-v3-0-pro-text",
          "provider": "wavespeed",
          "providerModelPath": "kwaivgi/kling-v3.0-pro/text-to-video",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": null,
              "type": "string",
              "required": true
            },
            {
              "name": "aspect_ratio",
              "class": "intent",
              "flag": null,
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
              "flag": null,
              "type": "number",
              "default": 5,
              "required": false,
              "min": 3,
              "max": 15
            },
            {
              "name": "sound",
              "class": "default",
              "flag": null,
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
          ],
          "billingDimensions": [
            "duration",
            "audioMode"
          ]
        },
        {
          "endpointKey": "video-kling-v3-0-pro-image",
          "provider": "wavespeed",
          "providerModelPath": "kwaivgi/kling-v3.0-pro/image-to-video",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": null,
              "type": "string",
              "required": true
            },
            {
              "name": "image",
              "class": "intent",
              "flag": null,
              "type": "media-url",
              "required": true
            },
            {
              "name": "duration",
              "class": "default",
              "flag": null,
              "type": "number",
              "default": 5,
              "required": false,
              "min": 3,
              "max": 15
            },
            {
              "name": "sound",
              "class": "default",
              "flag": null,
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
          ],
          "billingDimensions": [
            "duration",
            "audioMode"
          ]
        },
        {
          "endpointKey": "video-kling-v3-0-std-text",
          "provider": "wavespeed",
          "providerModelPath": "kwaivgi/kling-v3.0-std/text-to-video",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": null,
              "type": "string",
              "required": true
            },
            {
              "name": "aspect_ratio",
              "class": "intent",
              "flag": null,
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
              "flag": null,
              "type": "number",
              "default": 5,
              "required": false,
              "min": 3,
              "max": 15
            },
            {
              "name": "sound",
              "class": "default",
              "flag": null,
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
          ],
          "billingDimensions": [
            "duration",
            "audioMode"
          ]
        },
        {
          "endpointKey": "video-kling-v3-0-std-image",
          "provider": "wavespeed",
          "providerModelPath": "kwaivgi/kling-v3.0-std/image-to-video",
          "fields": [
            {
              "name": "prompt",
              "class": "intent",
              "flag": null,
              "type": "string",
              "required": true
            },
            {
              "name": "image",
              "class": "intent",
              "flag": null,
              "type": "media-url",
              "required": true
            },
            {
              "name": "duration",
              "class": "default",
              "flag": null,
              "type": "number",
              "default": 5,
              "required": false,
              "min": 3,
              "max": 15
            },
            {
              "name": "sound",
              "class": "default",
              "flag": null,
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
          ],
          "billingDimensions": [
            "duration",
            "audioMode"
          ]
        },
        {
          "endpointKey": "video-infinitetalk",
          "provider": "wavespeed",
          "providerModelPath": "wavespeed-ai/infinitetalk",
          "fields": [
            {
              "name": "image",
              "class": "intent",
              "flag": null,
              "type": "media-url",
              "required": true
            },
            {
              "name": "audio",
              "class": "intent",
              "flag": null,
              "type": "media-url",
              "required": true
            },
            {
              "name": "resolution",
              "class": "default",
              "flag": null,
              "type": "string",
              "default": "720p",
              "required": false
            },
            {
              "name": "seed",
              "class": "intent",
              "flag": null,
              "type": "number",
              "required": false
            },
            {
              "name": "prompt",
              "class": "intent",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "mask_image",
              "class": "intent",
              "flag": null,
              "type": "media-url",
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
          ],
          "billingDimensions": [
            "duration"
          ]
        },
        {
          "endpointKey": "video-kling-v2-6-pro-motion-control",
          "provider": "wavespeed",
          "providerModelPath": "kwaivgi/kling-v2.6-pro/motion-control",
          "fields": [
            {
              "name": "image",
              "class": "intent",
              "flag": null,
              "type": "media-url",
              "required": true
            },
            {
              "name": "video",
              "class": "intent",
              "flag": null,
              "type": "media-url",
              "required": true
            },
            {
              "name": "character_orientation",
              "class": "intent",
              "flag": null,
              "type": "string",
              "required": true
            },
            {
              "name": "prompt",
              "class": "intent",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "negative_prompt",
              "class": "intent",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "keep_original_sound",
              "class": "intent",
              "flag": null,
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
          ],
          "billingDimensions": [
            "duration"
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
      "endpoints": [
        {
          "endpointKey": "transcription-video",
          "provider": "wavespeed",
          "providerModelPath": "wavespeed-ai/openai-whisper-with-video",
          "fields": [
            {
              "name": "video",
              "class": "intent",
              "flag": "--video",
              "type": "media-url",
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
          ],
          "billingDimensions": [
            "mediaSeconds"
          ]
        }
      ]
    }
  ],
  "voice-batch-runner": [
    {
      "skill": "voice-batch-runner",
      "mode": "cli-runner",
      "surface": "request-json",
      "verb": "create",
      "domain": "media",
      "capability": "media-generation",
      "endpointKeys": [
        "voice-design",
        "voice-clone"
      ],
      "endpoints": [
        {
          "endpointKey": "voice-design",
          "provider": "wavespeed",
          "providerModelPath": "wavespeed-ai/qwen3-tts/voice-design",
          "fields": [
            {
              "name": "text",
              "class": "intent",
              "flag": null,
              "type": "string",
              "required": true
            },
            {
              "name": "voice_description",
              "class": "intent",
              "flag": null,
              "type": "string",
              "required": true
            },
            {
              "name": "language",
              "class": "default",
              "flag": null,
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
          ],
          "billingDimensions": [
            "billableUnitCount"
          ]
        },
        {
          "endpointKey": "voice-clone",
          "provider": "wavespeed",
          "providerModelPath": "wavespeed-ai/qwen3-tts/voice-clone",
          "fields": [
            {
              "name": "text",
              "class": "intent",
              "flag": null,
              "type": "string",
              "required": true
            },
            {
              "name": "audio",
              "class": "intent",
              "flag": null,
              "type": "media-url",
              "required": true
            },
            {
              "name": "reference_text",
              "class": "intent",
              "flag": null,
              "type": "string",
              "required": false
            },
            {
              "name": "language",
              "class": "default",
              "flag": null,
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
          ],
          "billingDimensions": [
            "billableUnitCount"
          ]
        }
      ]
    }
  ],
  "youtube-research": [
    {
      "skill": "youtube-research",
      "mode": "cli-runner",
      "surface": "request-json",
      "verb": "scrape",
      "domain": "research",
      "capability": "public-content-collection",
      "sourceKeys": [
        "youtube-videos"
      ],
      "sources": [
        {
          "sourceKey": "youtube-videos",
          "datasetId": "gd_lk56epmy2i5g7lzu0k"
        }
      ]
    },
    {
      "skill": "youtube-research",
      "mode": "cli-runner",
      "surface": "request-json",
      "verb": "collect",
      "domain": "research",
      "capability": "hosted-collection",
      "collectionKeys": [
        "youtube-channel-summary",
        "youtube-comments",
        "youtube-video-download"
      ],
      "collections": [
        {
          "collectionKey": "youtube-channel-summary",
          "actorId": "automation-lab/youtube-channel-scraper"
        },
        {
          "collectionKey": "youtube-comments",
          "actorId": "apidojo/youtube-comments-scraper"
        },
        {
          "collectionKey": "youtube-video-download",
          "actorId": "scrapearchitect/youtube-video-downloader"
        }
      ]
    }
  ]
} as const;
