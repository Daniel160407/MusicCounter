# Music Counter (browser extension)

## Keep the extension and the iOS app in step

This extension has an iOS companion app at `../MusicCounterIOS` (github.com/Daniel160407/MusicCounterIOS).
They are one product: **any user-facing feature, setting, or behavior change made here must also be
made in the iOS app in the same task, and vice versa.** Do not finish a task with only one side done.

- Adapt the feature to each platform's idiom (popup tab ↔ SwiftUI screen, toolbar badge ↔ tab badge or
  notification) rather than copying the UI literally, but keep the same behavior, thresholds and wording.
- Shared definitions must match exactly — same ids, goals, keys and order:
  - Achievements: `achievements.js` ↔ `MusicCounter/Achievements.swift`
  - Sync format (Firestore layout, part names, field names): `sync.js` ↔ `MusicCounter/Sync.swift`,
    `MusicCounter/SyncFormat.swift`
  - Settings shared through sync (e.g. history retention values): `background.js` ↔ `MusicCounter/Models.swift`
- Update both READMEs when behavior changes.
- Verify both sides: syntax-check the JS (`node`), and build the app
  (`xcodebuild -project MusicCounter.xcodeproj -scheme MusicCounter -destination 'generic/platform=iOS Simulator' build`
  from `../MusicCounterIOS`; run `xcodegen generate` there first if Swift files were added or removed).
- If a change truly only applies to one platform (e.g. YouTube page detection, MPMediaLibrary reading),
  say so explicitly in your summary instead of silently skipping the other side.
