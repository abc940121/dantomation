// UI strings of the chat package (en and zh-tw). Our own file (MIT). Keys are prefixed "dchat." so
// they never collide with the OMB packs; the copy, day and code keys it reuses come from those packs.
export const en: Record<string, string> = {
  "dchat.older": "Load older messages",
  "dchat.empty": "No messages yet.",
  "dchat.working": "Working",
  "dchat.stop": "Stop",
  "dchat.stopFailed": "Could not stop: {error}",
  "dchat.send": "Send",
  "dchat.placeholder": "Message {name}",
  "dchat.sendFailed": "Could not send: {error}",
  "dchat.toolDone": "Done",
  "dchat.toolFailed": "Failed",
  "dchat.toolRunning": "Running",
  "dchat.messages": "Conversation",
};

export const zhTw: Record<string, string> = {
  "dchat.older": "載入更早的訊息",
  "dchat.empty": "還沒有訊息。",
  "dchat.working": "處理中",
  "dchat.stop": "停止",
  "dchat.stopFailed": "無法停止：{error}",
  "dchat.send": "傳送",
  "dchat.placeholder": "傳訊息給 {name}",
  "dchat.sendFailed": "無法傳送：{error}",
  "dchat.toolDone": "完成",
  "dchat.toolFailed": "失敗",
  "dchat.toolRunning": "執行中",
  "dchat.messages": "對話",
};
