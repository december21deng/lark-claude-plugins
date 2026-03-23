# Test Coverage — Feature & Test Case Matrix

151 tests across 11 files. All passing.

```bash
cd dispatcher && bun test
```

---

## 1. Message Processing

### 1.1 Text Extraction (`receiver.test.ts`)

| Feature | Test Case | Status |
|---------|-----------|--------|
| Text message parsing | `text message extraction` | ✅ |
| Empty text handling | `empty text message` | ✅ |
| Text with @mentions | `text message with mentions` | ✅ |
| Invalid JSON fallback | `invalid JSON returns raw content` | ✅ |

### 1.2 Rich Text (Post) Parsing (`receiver.test.ts`)

| Feature | Test Case | Status |
|---------|-----------|--------|
| Title extraction | `simple rich text with title` | ✅ |
| No title | `rich text without title` | ✅ |
| Hyperlinks | `rich text with link` | ✅ |
| @mentions in post | `rich text with at-mention` | ✅ |
| Image placeholder | `rich text with image placeholder` | ✅ |
| Code blocks | `rich text with code block` | ✅ |
| Empty post fallback | `empty rich text returns fallback` | ✅ |

### 1.3 Image Detection (`receiver.test.ts`)

| Feature | Test Case | Status |
|---------|-----------|--------|
| Image key extraction | `image message extracts image_key` | ✅ |
| Non-image returns undefined | `non-image message returns undefined` | ✅ |
| Missing key | `image message without key returns undefined` | ✅ |

### 1.4 Mention Placeholder Replacement (`receiver.test.ts`)

| Feature | Test Case | Status |
|---------|-----------|--------|
| Single @_user_N → name(id) | `replaces @_user_1 with name and open_id` | ✅ |
| Multiple mentions | `replaces multiple mentions` | ✅ |
| No mentions passthrough | `no mentions returns text unchanged` | ✅ |
| Name without open_id | `mention with name but no open_id` | ✅ |
| Open_id without name | `mention without name uses open_id` | ✅ |
| Empty text | `empty text returns empty` | ✅ |

### 1.5 Bot Mention Detection (`receiver.test.ts`)

| Feature | Test Case | Status |
|---------|-----------|--------|
| Bot is mentioned | `bot is mentioned` | ✅ |
| Bot not mentioned | `bot is not mentioned` | ✅ |
| No mentions array | `no mentions at all` | ✅ |
| No botOpenId | `no botOpenId returns false` | ✅ |

---

## 2. Access Control

### 2.1 Gate — DM Policy (`gate.test.ts`)

| Feature | Test Case | Status |
|---------|-----------|--------|
| open allows all | `dmPolicy=open allows all DMs` | ✅ |
| disabled drops all | `dmPolicy=disabled drops all DMs` | ✅ |
| pairing returns code | `dmPolicy=pairing returns pair for unknown sender` | ✅ |
| pairing allows allowlisted | `dmPolicy=pairing allows allowlisted sender` | ✅ |
| allowlist drops unknown | `dmPolicy=allowlist drops unknown sender` | ✅ |
| allowlist allows listed | `dmPolicy=allowlist allows allowlisted sender` | ✅ |

### 2.2 Gate — Group Policy (`gate.test.ts`)

| Feature | Test Case | Status |
|---------|-----------|--------|
| Unknown group dropped | `unknown group without mention is dropped` | ✅ |
| autoReply allows without @ | `autoReply group allows without mention` | ✅ |
| requireMention drops without @ | `configured group with requireMention=true drops without mention` | ✅ |
| requireMention allows with @ | `configured group with requireMention=true allows with mention` | ✅ |
| requireMention=false allows | `configured group with requireMention=false allows without mention` | ✅ |
| allowFrom restricts senders | `group with allowFrom restricts to specific senders` | ✅ |
| allowFrom allows listed | `group with allowFrom allows listed sender` | ✅ |
| autoReply overrides config | `autoReply overrides requireMention in groups config` | ✅ |

### 2.3 Gate — Dynamic Groups (`gate.test.ts`)

| Feature | Test Case | Status |
|---------|-----------|--------|
| Dynamic group requireMention | `dynamically added group with requireMention=true works` | ✅ |
| Dynamic autoReply group | `dynamically added autoReply group works` | ✅ |

---

## 3. Admin Management (`admin.test.ts`)

### 3.1 Admin CRUD

| Feature | Test Case | Status |
|---------|-----------|--------|
| Superadmin adds admin | `superadmin can add admin` | ✅ |
| Non-superadmin blocked | `non-superadmin cannot add admin` | ✅ |
| Remove admin | `superadmin can remove admin` | ✅ |
| Remove non-existent | `remove non-existent admin fails` | ✅ |
| List admins | `list admins includes superadmins and admins` | ✅ |
| Duplicate add idempotent | `duplicate admin add is idempotent` | ✅ |

### 3.2 Group CRUD

| Feature | Test Case | Status |
|---------|-----------|--------|
| Admin adds group | `admin can add group` | ✅ |
| Non-admin blocked | `non-admin cannot add group` | ✅ |
| Add with auto_reply | `add group with auto_reply option` | ✅ |
| Add with require_mention | `add group with require_mention option` | ✅ |
| Remove group | `remove group` | ✅ |
| Remove non-existent | `remove non-existent group fails` | ✅ |
| List groups | `list groups` | ✅ |

### 3.3 Live Config & Persistence

| Feature | Test Case | Status |
|---------|-----------|--------|
| Merge dynamic groups | `getLiveAccessConfig merges dynamic groups` | ✅ |
| Admins persist to file | `admins persist to file` | ✅ |
| Groups persist to file | `groups persist to file` | ✅ |
| Reload from files | `reload from persisted files` | ✅ |

### 3.4 Edge Cases

| Feature | Test Case | Status |
|---------|-----------|--------|
| Unknown action | `unknown action returns error` | ✅ |
| Missing target_id | `missing target_id returns error` | ✅ |

---

## 4. Emoji System

### 4.1 Emoji Type Resolution (`emoji-resolve.test.ts`)

| Feature | Test Case | Status |
|---------|-----------|--------|
| Unicode 👀 → GLANCE | `unicode 👀 → GLANCE` | ✅ |
| Unicode 👍 → THUMBSUP | `unicode 👍 → THUMBSUP` | ✅ |
| Unicode ✅ → DONE | `unicode ✅ → DONE` | ✅ |
| Unicode 🤔 → THINKING | `unicode 🤔 → THINKING` | ✅ |
| Unicode 🔥 → Fire | `unicode 🔥 → Fire (mixed case)` | ✅ |
| Alias eyes → GLANCE | `alias "eyes" → GLANCE` | ✅ |
| Alias thumbsup → THUMBSUP | `alias "thumbsup" → THUMBSUP` | ✅ |
| Alias done → DONE | `alias "done" → DONE` | ✅ |
| Alias typing → Typing | `alias "typing" → Typing (mixed case)` | ✅ |
| Alias onit → OnIt | `alias "onit" → OnIt (mixed case)` | ✅ |
| Alias fire → Fire | `alias "fire" → Fire` | ✅ |
| Passthrough DONE | `valid type "DONE" passes through` | ✅ |
| Passthrough Typing | `valid type "Typing" passes through` | ✅ |
| Passthrough OnIt | `valid type "OnIt" passes through` | ✅ |
| Passthrough FACEPALM | `valid type "FACEPALM" passes through` | ✅ |
| Passthrough THUMBSUP | `valid type "THUMBSUP" passes through` | ✅ |
| Unknown passthrough | `unknown type "CustomEmoji" passes through` | ✅ |

### 4.2 Reaction Tracker — State Machine (`reaction-tracker.test.ts`)

| Feature | Test Case | Status |
|---------|-----------|--------|
| First transition (add only) | `first transition adds emoji without removing` | ✅ |
| Transition (remove + add) | `second transition removes old emoji then adds new` | ✅ |
| Full lifecycle | `full lifecycle: Typing → OnIt → DONE` | ✅ |
| Cleanup | `cleanup removes current emoji and deletes entry` | ✅ |
| Cleanup no-op | `cleanup on non-existent message is a no-op` | ✅ |
| Independent tracking | `multiple messages tracked independently` | ✅ |
| Error transition | `error transition: Typing → FACEPALM` | ✅ |
| DONE is permanent | `DONE emoji is permanent — no remove call after transition` | ✅ |
| FACEPALM is permanent | `FACEPALM emoji is permanent — cleanup is a no-op` | ✅ |
| DONE clears tracker entry | `DONE removes entry from tracker but not from message` | ✅ |

---

## 5. Reply Threading (`reply-threading.test.ts`)

### 5.1 Reply-to Fallback

| Feature | Test Case | Status |
|---------|-----------|--------|
| reply_to used first | `uses reply_to when provided` | ✅ |
| Fallback to message_id | `falls back to message_id when no reply_to` | ✅ |
| Fallback to senderMap latest | `falls back to latest messageId from senderMap` | ✅ |
| Nothing available | `returns undefined when nothing available` | ✅ |
| Priority: reply_to > senderMap | `reply_to takes precedence over senderMap` | ✅ |

### 5.2 SenderMap Tracking

| Feature | Test Case | Status |
|---------|-----------|--------|
| First message creates entry | `first message creates entry` | ✅ |
| Second appends (no overwrite) | `second message appends to existing entry` | ✅ |
| Different convKeys independent | `different convKeys are independent` | ✅ |

### 5.3 Batch Emoji on Reply

| Feature | Test Case | Status |
|---------|-----------|--------|
| Single message batch | `single message: returns [A], clears list` | ✅ |
| Merged reply batch | `two messages merged reply: returns [A, B], clears list` | ✅ |
| Fresh accumulation after clear | `after batch clear, new messages accumulate fresh` | ✅ |
| No entry returns empty | `no entry returns empty array` | ✅ |
| Two reply waves | `three messages, two replies scenario` | ✅ |

---

## 6. Card JSON (`card-detection.test.ts`)

### 6.1 Card Detection

| Feature | Test Case | Status |
|---------|-----------|--------|
| v2.0 card detected | `v2.0 card with schema + body.elements is detected` | ✅ |
| v1 card detected | `v1 card with config + header + elements is detected` | ✅ |
| Plain text rejected | `plain text is not detected as card` | ✅ |
| Non-card JSON rejected | `JSON without card structure is not detected` | ✅ |
| Schema without body rejected | `JSON with only schema but no body.elements is not detected` | ✅ |
| Elements not array rejected | `JSON with schema + body but elements not array is not detected` | ✅ |
| Invalid JSON rejected | `invalid JSON is not detected` | ✅ |
| Empty string rejected | `empty string is not detected` | ✅ |
| Config without header rejected | `JSON with only config (no header) is not detected` | ✅ |

### 6.2 Card Text Extraction (Fallback)

| Feature | Test Case | Status |
|---------|-----------|--------|
| Header title | `extracts header title` | ✅ |
| Markdown content | `extracts markdown content` | ✅ |
| Div text | `extracts div text` | ✅ |
| Column set | `extracts from column_set` | ✅ |
| Collapsible panel | `extracts from collapsible_panel` | ✅ |
| Header + body combined | `combines header + body elements` | ✅ |
| Invalid JSON returns empty | `returns empty string for invalid JSON` | ✅ |
| No extractable content | `returns empty string for card with no extractable content` | ✅ |
| Null elements skipped | `skips null/undefined elements` | ✅ |

---

## 7. Infrastructure

### 7.1 Mutex (`mutex.test.ts`)

| Feature | Test Case | Status |
|---------|-----------|--------|
| Single acquire/release | `single acquire/release works` | ✅ |
| FIFO serialization | `multiple concurrent acquires are serialized in FIFO order` | ✅ |
| Release unblocks next | `release unblocks next waiter` | ✅ |
| Reacquire after release | `mutex can be reacquired after full release` | ✅ |

### 7.2 Dedup (`dedup.test.ts`)

| Feature | Test Case | Status |
|---------|-----------|--------|
| First message is new | `first message is marked as new` | ✅ |
| Duplicate detection | `same message ID is marked as duplicate` | ✅ |
| Different IDs both new | `different message IDs are both new` | ✅ |
| TTL expiry | `TTL expiry works` | ✅ |
| Max capacity eviction | `max capacity evicts oldest entry` | ✅ |

### 7.3 Router (`router.test.ts`)

| Feature | Test Case | Status |
|---------|-----------|--------|
| Private chat convKey | `private chat: lark:chatId` | ✅ |
| Group convKey | `group chat without thread: lark:chatId` | ✅ |
| Thread convKey | `group chat with thread: lark:chatId_thread_threadId` | ✅ |
| Platform prefix | `different platform prefix` | ✅ |
| No threadId | `thread with no threadId is same as no thread` | ✅ |
| /clear parsed | `/clear is parsed` | ✅ |
| /new parsed | `/new is parsed` | ✅ |
| /status parsed | `/status is parsed` | ✅ |
| /help parsed | `/help is parsed` | ✅ |
| Case insensitive | `slash commands are case-insensitive` | ✅ |
| Trailing text | `slash command with trailing text` | ✅ |
| Leading whitespace | `slash command with leading whitespace` | ✅ |
| Unknown command null | `unknown slash commands return null` | ✅ |
| Non-slash null | `non-slash text returns null` | ✅ |
| Empty string null | `empty string returns null` | ✅ |
| Slash only null | `slash only returns null` | ✅ |

### 7.4 Session Store (`session-store.test.ts`)

| Feature | Test Case | Status |
|---------|-----------|--------|
| Save and load | `save and load session IDs` | ✅ |
| Empty store loads | `empty store loads without error` | ✅ |
| Multiple sessions | `multiple sessions saved correctly` | ✅ |
| Delete session | `delete removes a session` | ✅ |
| Overwrite session | `overwrite existing session` | ✅ |
| Corrupt file recovery | `corrupt file starts fresh` | ✅ |

---

## Summary

| Module | Tests | File |
|--------|-------|------|
| Message parsing + mentions | 27 | `receiver.test.ts` |
| Gate (access control) | 16 | `gate.test.ts` |
| Admin management | 19 | `admin.test.ts` |
| Emoji type resolution | 17 | `emoji-resolve.test.ts` |
| Reaction tracker | 10 | `reaction-tracker.test.ts` |
| Reply threading + batch | 13 | `reply-threading.test.ts` |
| Card detection + extraction | 18 | `card-detection.test.ts` |
| Mutex | 4 | `mutex.test.ts` |
| Dedup | 5 | `dedup.test.ts` |
| Router | 16 | `router.test.ts` |
| Session store | 6 | `session-store.test.ts` |
| **Total** | **151** | **11 files** |
