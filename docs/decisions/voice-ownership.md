# Voice ownership

Modules: rooms, chat-endpoint, voice

Voice ownership is keyed by room and member: `canUseVoice(voice, memberId, roomId)`. No other speaker may use a bot's voice.
