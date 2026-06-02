// Generated from the PostPlus Cloud hosted catalog release gate.
// Keep keys in sync with apps/web hosted capability and collection catalogs.

export const RESEARCH_COLLECTION_HINTS: Record<string, Record<string, unknown>> = {
  'google-trends-fast': {
    queries: ['portable blender'],
  },
  'instagram-comments': {
    directUrls: ['https://www.instagram.com/p/example/'],
    resultsLimit: 5,
  },
  'instagram-email-search': {
    Country: 'www',
    Email_Type: '0',
    Keyword: 'skincare creator',
    Limit: '10',
    social_network: 'instagram.com/',
  },
  'instagram-hashtags': {
    hashtags: ['desksetup'],
    resultsLimit: 3,
  },
  'instagram-posts': {
    resultsLimit: 3,
    username: ['openai'],
  },
  'instagram-profiles': {
    resultsLimit: 3,
    usernames: ['instagram'],
  },
  'instagram-search': {
    searchLimit: 3,
    searchTerms: ['skincare routine'],
    searchType: 'user',
  },
  'tiktok-ads-top': {
    include_analytics: true,
    limit: 1,
  },
  'tiktok-comments': {
    postURLs: ['https://www.tiktok.com/@example/video/1234567890'],
    resultsPerPage: 5,
  },
  'tiktok-profiles': {
    usernames: ['tiktok'],
  },
  'tiktok-related-videos': {
    maxItems: 3,
    postURLs: ['https://www.tiktok.com/@example/video/1234567890'],
  },
  'tiktok-users': {
    maxItems: 5,
    searchQueries: ['skincare creator'],
  },
  'tiktok-videos': {
    maxItems: 3,
    proxyCountryCode: 'US',
    queries: ['portable blender'],
    searchSection: '/video',
  },
  'youtube-channel-summary': {
    channels: ['@Google'],
    includeChannelInfo: true,
    includeVideos: false,
    maxVideosPerChannel: 0,
  },
  'youtube-comments': {
    maxComments: 10,
    startUrls: ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
  },
  'youtube-video-download': {
    urls: ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
  },
} as const;

export const PUBLIC_CONTENT_SOURCE_HINTS: Record<string, Array<Record<string, unknown>>> = {
  'facebook-group-posts': [
    {
      url: 'https://www.facebook.com/groups/example',
    },
  ],
  'facebook-post-by-url': [
    {
      url: 'https://www.facebook.com/openai/posts/example',
    },
  ],
  'facebook-profile-posts': [
    {
      url: 'https://www.facebook.com/openai',
    },
  ],
  'youtube-videos': [
    {
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    },
  ],
} as const;

export const PUBLIC_CONTENT_DISCOVERY_TOOL_HINTS: Record<string, Record<string, unknown>> = {
  'web-search': {
    limit: 5,
    query: 'portable blender reviews',
  },
} as const;

export const MEDIA_ENDPOINT_HINTS: Record<string, Record<string, unknown>> = {
  'image-gpt-image-2-edit': {
    inputUrls: ['https://example.com/reference-image.png'],
    prompt: 'Edit the reference into a clean product-style vertical image.',
    quality: 'medium',
    size: '1024x1024',
  },
  'image-gpt-image-2-text': {
    aspect_ratio: '9:16',
    prompt: 'A realistic vertical product image on a clean white desk.',
    quality: 'medium',
    size: '1024x1024',
  },
  'image-nano-banana-2-edit': {
    inputUrls: ['https://example.com/reference-image.png'],
    prompt: 'Edit the reference into a clean product-style vertical image.',
    quality: 'medium',
    size: '1024x1024',
  },
  'image-nano-banana-2-text': {
    aspect_ratio: '9:16',
    prompt: 'A realistic vertical product image on a clean white desk.',
    quality: 'medium',
    size: '1024x1024',
  },
  'image-nano-banana-pro-edit-1k': {
    inputUrls: ['https://example.com/reference-image.png'],
    prompt: 'Edit the reference into a clean product-style vertical image.',
    resolution: '1k',
  },
  'image-nano-banana-pro-edit-2k': {
    inputUrls: ['https://example.com/reference-image.png'],
    prompt: 'Edit the reference into a clean product-style vertical image.',
    resolution: '2k',
  },
  'image-nano-banana-pro-edit-4k': {
    inputUrls: ['https://example.com/reference-image.png'],
    prompt: 'Edit the reference into a clean product-style vertical image.',
    resolution: '4k',
  },
  'image-nano-banana-pro-text-1k': {
    aspect_ratio: '9:16',
    prompt: 'A realistic vertical product image on a clean white desk.',
    resolution: '1k',
  },
  'image-nano-banana-pro-text-2k': {
    aspect_ratio: '9:16',
    prompt: 'A realistic vertical product image on a clean white desk.',
    resolution: '2k',
  },
  'image-nano-banana-pro-text-4k': {
    aspect_ratio: '9:16',
    prompt: 'A realistic vertical product image on a clean white desk.',
    resolution: '4k',
  },
  'image-seedream-v5-lite-edit': {
    inputUrls: ['https://example.com/reference-image.png'],
    prompt: 'Edit the reference into a clean product-style vertical image.',
    size: '1024x1024',
  },
  'image-seedream-v5-lite-edit-sequential': {
    inputUrls: ['https://example.com/reference-image.png'],
    prompt: 'Create a coherent sequence of edited product reference images.',
    size: '1024x1024',
  },
  'image-seedream-v5-lite-sequential': {
    aspect_ratio: '9:16',
    prompt: 'Create a coherent sequence of vertical product images.',
    size: '1024x1024',
  },
  'image-seedream-v5-lite-text': {
    aspect_ratio: '9:16',
    prompt: 'A realistic vertical product image on a clean white desk.',
    size: '1024x1024',
  },
  'transcription-whisper': {
    audio: 'https://example.com/input-audio.mp3',
    language: 'en',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
  },
  'transcription-whisper-turbo': {
    audio: 'https://example.com/input-audio.mp3',
    language: 'en',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
  },
  'transcription-whisper-with-video': {
    language: 'en',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
    video: 'https://example.com/input-video.mp4',
  },
  'video-infinitetalk': {
    audio: 'https://example.com/voiceover.wav',
    image: 'https://example.com/persona.png',
    prompt: 'Talking-head delivery in a natural vertical social ad style.',
  },
  'video-kling-v2-6-pro-motion-control': {
    character_orientation: 'image',
    image: 'https://example.com/subject.png',
    video: 'https://example.com/reference-motion.mp4',
  },
  'video-kling-v3-0-pro-image': {
    duration: 5,
    image: 'https://example.com/start-frame.png',
    prompt: 'Animate the product in a clean realistic vertical scene.',
    sound: false,
  },
  'video-kling-v3-0-pro-text': {
    aspect_ratio: '9:16',
    duration: 5,
    prompt: 'A realistic vertical short-form product reveal.',
    sound: false,
  },
  'video-kling-v3-0-std-image': {
    duration: 5,
    image: 'https://example.com/start-frame.png',
    prompt: 'Animate the product in a clean realistic vertical scene.',
    sound: false,
  },
  'video-kling-v3-0-std-text': {
    aspect_ratio: '9:16',
    duration: 5,
    prompt: 'A realistic vertical short-form product reveal.',
    sound: false,
  },
  'video-wanx2-1-i2v-turbo': {
    aspect_ratio: '9:16',
    duration: 5,
    image: 'https://example.com/start-frame.png',
    prompt: 'A realistic vertical short-form product reveal.',
    resolution: '720p',
  },
  'video-wanx2-1-t2v-turbo': {
    aspect_ratio: '9:16',
    duration: 5,
    prompt: 'A realistic vertical short-form product reveal.',
    resolution: '720p',
  },
  'video-seedance-2-image': {
    duration: 5,
    image: 'https://example.com/start-frame.png',
    prompt: 'A realistic vertical short-form product reveal.',
    resolution: '720p',
  },
  'video-seedance-2-image-turbo': {
    duration: 5,
    image: 'https://example.com/start-frame.png',
    prompt: 'A realistic vertical short-form product reveal.',
    resolution: '720p',
  },
  'video-seedance-2-text': {
    duration: 5,
    prompt: 'A realistic vertical short-form product reveal.',
    resolution: '720p',
  },
  'video-seedance-2-text-turbo': {
    duration: 5,
    prompt: 'A realistic vertical short-form product reveal.',
    resolution: '720p',
  },
  'voice-qwen3-clone': {
    reference_audio: 'https://example.com/reference-voice.wav',
    text: 'Short voiceover line to synthesize.',
  },
  'voice-qwen3-design': {
    language: 'en',
    text: 'Short voiceover line to synthesize.',
    voiceDescription: 'Warm, clear, natural creator voice.',
  },
} as const;

export const VIDEO_ANALYSIS_MODEL_HINTS: Record<string, Record<string, unknown>> = {
  'gemini-video-analysis': {
    contents: [
      {
        parts: [
          {
            text: 'Analyze this short video and return concise creative observations.',
          },
        ],
      },
    ],
  },
} as const;
