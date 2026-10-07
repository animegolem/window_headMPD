# Follow-up 7: packaging, signing, permissions, start-up and updates

**Date:** 2026-10-07 · **Gap raised by the critic:** "Standalone-app packaging, signing and permissions are not covered by any lane." · **Machine:** macOS 27.0, arm64, SDK 27.0 (`sw_vers`, `xcrun`).

Tags: **[M]** measured by me on this machine. **[S#]** stated by an outside source (list at the end). **[I]** my inference, reasoning shown. **[R]** recommendation. **UNCONFIRMED** I could not confirm it. I changed nothing and did not talk to MPD.

## 1. Answer in brief

1. **Process-tap floor is macOS 14.2, per Apple.** The local SDK header and Apple's own sample page both say 14.2. "14.4" comes from three open-source apps' READMEs, and no Apple statement backs it. It is moot on this Mac (27.0). `winamp-better.md` is wrong as written. `landscape.md` is right.
2. **Nothing here blocks EQing the headphones today.** The current app plays to the speaker output and reads a FIFO. It needs no privacy permission, and nothing needs notarizing to run on the owner's own Mac.
3. **The real trap is the Google Drive library.** A background server can only be asked for Drive access if it lives in a signed app bundle whose Info.plist carries a File Provider usage string. It also needs a signing identity that does not change on every rebuild.
4. **Signing is the owner's.** This Mac holds exactly one code-signing identity, of type Apple Development. That is enough for a stable identity now. Developer ID and notarization need the paid Apple program, and only matter when giving the app to other people.
5. **Ship one `.app`:** the Tauri window, the audio server as a bundled helper, and a bundled login agent. One identity signs all of it, and one notarization covers all of it.
6. **Skip the App Sandbox.** It is mandatory only for the Mac App Store, and the transparent skin window already rules the App Store out.

## 2. Process-tap availability: 14.2 or 14.4

| Source | Says |
|---|---|
| Local SDK header `AudioHardwareTapping.h` (SDK 27.0) | `AudioHardwareCreateProcessTap` and `...DestroyProcessTap` are `API_AVAILABLE(macos(14.2))` [M] [S1] |
| Apple, "Capturing system audio with Core Audio taps" | "ensure that you're using macOS 14.2 or later" [S2] |
| AudioCap README (BSD-2 sample app) | "With macOS 14.4, Apple introduced new API in CoreAudio..." [S3] |
| ParaEQ and MacEQ READMEs | Both say 14.4. MacEQ calls it a "hard floor" and says the API "didn't exist before" 14.4, which contradicts the header [S4][S5] |
| DGR Labs blog | Tap exists since 14.2, but pin the deployment target to 14.4 because "earlier versions land in different TCC categories". No Apple source, no detail [S6] |

**Verdict.** Apple's floor is 14.2. I found no Apple text for a behavioural change at 14.4, so whether 14.2 and 14.3 differ in practice is UNCONFIRMED. The three 14.4 apps probably copied AudioCap [I]. **[R]** Declare 14.4 as the app's minimum anyway. It costs nothing and sidesteps the doubt. Tauri's default minimum is 10.13 [S7], so it must be raised.

## 3. Who owns the signing identity

**Measured.**
- `security find-identity -v -p codesigning` shows one valid identity, type **Apple Development**. There is no Developer ID Application certificate [M].
- Homebrew's `mpd` (0.24.15_1) and the owner's `nowplayd.app` are both **ad-hoc signed**. For both, `codesign -d -r-` prints `designated => cdhash H"..."`, so their identity is a hash of the exact file [M].
- `nowplayd.app` is `spctl`-rejected but is running right now under launchd (pid 33872), because it carries no quarantine attribute [M].
- `window_headMPD` has no signing identity, entitlements or Info.plist keys in `tauri.conf.json`, and has no built `.app` on disk [M].

**What the sources say.**
- Notarization needs a Developer ID certificate. Apple's list excludes "ad hoc, Apple Developer, or local development" certificates. It also needs the Hardened Runtime and a secure timestamp [S8].
- Developer ID certificates need paid membership and can be created only by the Account Holder. Apple's comparison table has no tick for notarization on the free tier [S9][S10]. A forum reply says the same ("Pay $99 and enrol") [S11].
- Gatekeeper checks quarantined (downloaded) software. Without notarization, a user must click "Open Anyway" in Privacy & Security [S12].
- Apple DTS on ad-hoc code: it "does not include a stable DR [designated requirement], and thus macOS is unable to tell that version N+1 of your app is the 'same code' as version N". Apple's advice: sign with a stable identity, "Apple Development, during development... Developer ID, for direct distribution" [S13]. Apple permission grants (TCC) follow that identity, so ad-hoc builds should lose their grants on every rebuild or brew upgrade [I]. Apple's own example is a lost Screen Recording grant after an update.

**Tiers [R].**
- **Tier 0, now (owner's Mac only):** sign every piece with the existing Apple Development identity. This is free and gives a stable identity. Notarization is not needed. Open-source precedent for the other option: MacEQ ships ad-hoc and un-notarized, and users approve it by hand [S5].
- **Tier 1, giving it to others:** Developer ID Application certificate, Hardened Runtime, notarization, staple. Tauri automates this from environment variables [S14]. A Homebrew cask now needs this too. Homebrew said it would disable casks that fail Gatekeeper in September 2026 [S15].
- **Who holds the key:** the owner, as Account Holder, in the login keychain. Agents should produce builds but never hold the key or notary password. The owner runs one signing script. Whether grants survive an Apple Development certificate renewal is UNCONFIRMED.

## 4. Which permission each piece needs

| Piece | Permission and Info.plist key | Evidence |
|---|---|---|
| Window app, today | None found. It plays through cpal, reads `/tmp/headspace.fifo`, talks to MPD over TCP, and writes one state file | [M] by reading `audio.rs`, `outputs.rs`, `lib.rs`, `mpd.rs` |
| Server playing to a device | None expected | [I] Apple's capture and privacy keys cover input, files and network, not output |
| **Server reading the Drive library** | File Provider consent. Key `NSFileProviderDomainUsageDescription` (macOS 10.15+) [S16]. Without the string there is no prompt, only a silent "Operation not permitted" [S17] | Key from Apple. The diagnosis is from a GitHub issue, secondary |
| Server listening on TCP (MPD protocol on 6600, HTTP) | None. "Listening for and accepting incoming TCP connections: no" [S18] | Apple TN3179 |
| Server advertising over Bonjour (phones find it) | Local Network, macOS 15+. Keys `NSLocalNetworkUsageDescription` and `NSBonjourServices`. Daemons started by launchd are exempt, **agents are not** [S18] | Apple TN3179 |
| System-wide EQ with a process tap | `NSAudioCaptureUsageDescription`. Prompt "the first time you start recording from an aggregate device that contains a tap". No entitlement is mentioned [S2]. Needs a stable signing identity [S6]. Under the App Sandbox the tap is "fragile" [S6] | Apple plus blog. Bug report: tap delivers all-zero buffers after minutes, no Apple reply [S19] |
| CamillaDSP-style capture from a virtual device | Microphone consent. Without it the capture "only records silence" [S20]. Hardened Runtime's `com.apple.security.device.audio-input` covers "access audio input using Core Audio" [S21] | CamillaDSP README, Apple. So the entitlement is needed [I] |
| Start at login | Registered by the user in System Settings, General, Login Items [S22] | Apple |

If the tap path needs the audio-input entitlement under Hardened Runtime, it is UNCONFIRMED. Apple's tap page lists none.

## 5. Signing and notarizing the pieces as a unit

**Layout [R].**
```
window_headMPD.app/
  Contents/Info.plist                     usage strings above, minimum macOS 14.4
  Contents/MacOS/window_headMPD           Tauri window
  Contents/MacOS/audiod                   server (MPD shim linked in)
  Contents/Library/LaunchAgents/<id>.plist  agent that runs audiod from inside the app
```
- `architecture.md` already links `mpdshim` into `audiod` as a module, so there is no third binary. A separate shim process would be one more helper, signed the same way.
- Tauri can embed a helper as `externalBin` [S23]. The bundler signs "all executables (including sidecars...)" since Tauri 1.5 [S24]. It also supports Info.plist merging, entitlements and Hardened Runtime (default `true`) [S7].
- The agent plist sits inside the signed bundle, so "neither the system nor a third party can modify [it] without breaking the code signature" [S22].
- The notary service "generates a ticket for the top-level file... as well as for each nested file". You can notarize a zip or disk image but cannot staple a zip, so staple the `.app` [S25].
- Put the usage strings in the **main app's** Info.plist. Apple DTS: if an agent is "a helper tool embedded in an app, TCC would recognise that and treat the app as the responsible code" [S26]. A second DTS answer says bundled code should inherit the app's grant, but "the only way to actually know... is to test it" [S27].

## 6. Starting at login and updating

**Login [R].** Register the bundled agent with `SMAppService.agent` (macOS 13+) [S22]. Keep `KeepAlive`, as `sh.brew.mpd` does today [M]. The agent then keeps playing when the window closes, and the owner sees it listed in Login Items. Tauri's own autostart plugin documents only a LaunchAgent mode, with no SMAppService support in its docs [S28].

**Update [R].**
1. The Tauri updater downloads and swaps the app. It needs its own minisign signature, which "cannot be disabled" and is separate from Apple's [S29].
2. The new window tells the old server to save state and exit. Apple DTS endorses this for `BundleProgram` agents: with one copy of the daemon on the system, killing it loads the new one [S30].
3. Fallback is unregister then register. Apple's header says a changed executable "must be re-registered", but a DTS engineer admits "I've definitely seen some weird stuff" [S31].
4. Replace files by writing a temp file and renaming it. Overwriting signed code in place can give a `Code Signature Invalid` crash. Apple's test is `ls -i` before and after: the inode must change [S32]. `nowplayd`'s installer already stages and swaps [M]. Whether Tauri's updater does this is UNCONFIRMED.
5. Expect a short audio gap. Update when idle.

## 7. Sandbox, and what happens to the takeover

**The sandbox is not needed.** App Store rules require it (2.4.5(i)). They also require public APIs only (2.5.1), no login start without consent, and updates only through the store [S33]. `tauri.conf.json` sets `macOSPrivateApi: true` for the transparent window [M]. Third-party sources say that blocks the App Store. Tauri's own docs I read were silent on it, so that link is UNCONFIRMED from Tauri. Apple's 2.5.1 rule stands either way. Notarization requires the Hardened Runtime but not the sandbox [S8]. **[R]** Developer ID, Hardened Runtime, no sandbox.

**If the current app were sandboxed anyway [I], not tested:**
- `/tmp/headspace.fifo` would be unreachable. Apple gives a sandboxed app read and write only in its container and in user-chosen locations [S34]. MPD, outside the sandbox, creates that FIFO.
- TCP to MPD would need `com.apple.security.network.client` [S35].
- `takeover.json` would still work. `outputs.rs` builds its path from `HOME`, which points into the container, so the file moves but keeps working.
- Conclusion: sandbox and the two-process takeover do not mix. The takeover disappears once the server owns the device, as `hidden-problems.md` A8 already says.

## 8. The 289 "Operation not permitted" errors: new evidence

This extends `architecture.md` section 2.4 and `hidden-problems.md` A7. The cause remains **UNCONFIRMED**.

- Homebrew installed this `mpd` build (0.24.15_1, poured from a bottle) at 2026-08-30 11:37:48, per its install receipt [M]. The last play before the install was `05 - Film At Forever.mp3` at 08-29 21:07. The **first** failure was that same file at 08-31 07:09, with no play attempts logged in between [M].
- Failures ended after 2026-09-06 14:51. The same album played normally on 09-06 [M].
- Each burst lasts seconds. On 08-31 the log has 85 `played` lines inside nine seconds, and every one of the ten distinct tracks also failed to open [M]. That is MPD looping a short queue, so those `played` lines are not successes.
- Today the files are readable from my own shell and carry no cloud-only flag [M].
- **Reading [I]:** a time-dependent denial, not bad files. It fits a permission identity that changed when the binary was swapped (`mpd` is ad-hoc, `designated => cdhash`, no Info.plist [M]). It also fits a Drive File Provider state. One album was tried during the window, so it is unknown whether other files would have opened.
- **The hole in the identity-swap reading:** the failures stopped on 09-06 with no reinstall logged. A bare ad-hoc binary with no usage string cannot raise a prompt [S17], so a lost grant could only return if the owner changed something in Privacy & Security around then. If the owner remembers no such change, the Drive File Provider explanation is the stronger one.
- To settle it, after the next burst check Privacy & Security for an `mpd` entry. Also run `log show --last 10m --predicate 'subsystem == "com.apple.TCC"'` (untested).

## 9. Corrections and extensions by lane

| Document | Location | Change |
|---|---|---|
| `landscape.md` | line 157, section 1.10 | **Right.** 14.2 is confirmed by the SDK header and Apple's page. That lane could not load Apple's page. |
| `winamp-better.md` | line 90, section 3 table | **Wrong as written.** "Apple's Core Audio process tap (macOS 14.4 or later)" gives the apps' README floor as Apple's. Apple's floor is 14.2. Low impact. |
| `eq-dsp.md` | lines 111 and 504 | Repeats the same second-hand 14.4. Same fix. |
| `architecture.md` | line 87 requirement (d), line 567 row 1, line 253 | **Incomplete, not wrong.** A bundle is necessary but not sufficient. Add the File Provider usage string and a stable signing identity. `nowplayd`'s ad-hoc signing has the same weakness. Add the tap permission and floor to the line-253 pointer. |
| `hidden-problems.md` | A7, A8 | A7: add section 8 above. A8 holds. Add that sandbox and takeover cannot coexist. |
| `mpd-audit.md` | the Drive and launchd notes | Add that Homebrew `mpd` is ad-hoc signed with no Info.plist. |

## 10. Unconfirmed, with cheap tests

1. Whether a launchd-started bundled helper can use the app's Drive consent. Test: a helper that lists the Drive folder, started both ways.
2. Whether grants survive Apple Development certificate renewal.
3. Whether taps need the audio-input entitlement under Hardened Runtime, or work in a sandbox.
4. Whether macOS 14.2 and 14.3 differ for taps.
5. Whether the Tauri updater replaces files by new inode.
6. Any macOS 27 change to notarization or privacy for a single user. Coverage I found is about managed Macs [S36].
7. The cause of the EPERM bursts (section 8).

## Sources

All fetched 2026-10-07. Apple documentation pages were read through their public documentation text.

- [S1] Local SDK: `/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/System/Library/Frameworks/CoreAudio.framework/Versions/A/Headers/AudioHardwareTapping.h`
- [S2] https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps
- [S3] https://github.com/insidegui/AudioCap
- [S4] https://github.com/joerawr/ParaEQ
- [S5] https://github.com/ksvan/MacEQ
- [S6] https://dgrlabs.co/blog/2026-04-25-capturing-system-audio-on-macos-in-2026.html
- [S7] https://v2.tauri.app/reference/config/
- [S8] https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
- [S9] https://developer.apple.com/support/compare-memberships/
- [S10] https://developer.apple.com/help/account/certificates/create-developer-id-certificates/
- [S11] https://developer.apple.com/forums/thread/121113
- [S12] https://support.apple.com/en-us/102445
- [S13] https://developer.apple.com/forums/thread/795739
- [S14] https://v2.tauri.app/distribute/sign/macos/
- [S15] https://brew.sh/2025/11/12/homebrew-5.0.0/
- [S16] https://developer.apple.com/documentation/bundleresources/information-property-list/nsfileproviderdomainusagedescription
- [S17] https://github.com/anthropics/claude-code/issues/74658 (secondary)
- [S18] https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy
- [S19] https://developer.apple.com/forums/thread/825780
- [S20] https://github.com/HEnquist/camilladsp/blob/master/backend_coreaudio.md
- [S21] https://developer.apple.com/documentation/security/hardened-runtime
- [S22] https://developer.apple.com/documentation/servicemanagement/smappservice and https://developer.apple.com/documentation/servicemanagement/updating-your-app-package-installer-to-use-the-new-service-management-api
- [S23] https://v2.tauri.app/develop/sidecar/
- [S24] https://tauri.app/blog/tauri-1-5/
- [S25] https://developer.apple.com/documentation/security/customizing-the-notarization-workflow
- [S26] https://developer.apple.com/forums/thread/694948
- [S27] https://developer.apple.com/forums/thread/763956
- [S28] https://v2.tauri.app/plugin/autostart/
- [S29] https://v2.tauri.app/plugin/updater/
- [S30] https://developer.apple.com/forums/thread/804561
- [S31] https://developer.apple.com/forums/thread/745412
- [S32] https://developer.apple.com/documentation/security/updating-mac-software
- [S33] https://developer.apple.com/app-store/review/guidelines/
- [S34] https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox
- [S35] https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.network.server (its text covers both the server and client network entitlements)
- [S36] https://www.jamf.com/blog/wwdc26-key-takeaways-for-apple-admins/

Local files read: `~/git/window_headMPD/src-tauri/{tauri.conf.json,Cargo.toml,capabilities/default.json,src/*.rs}`, `~/git/nowplayd/README.md`, `~/Library/LaunchAgents/sh.brew.mpd.plist`, `/opt/homebrew/etc/mpd.conf`, `~/.cache/mpd/log`. Scratch: `/tmp/msr-packaging/`.
