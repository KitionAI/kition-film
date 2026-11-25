//! What each command does, for people and models choosing one (kition-sdk `check_commands`).
//! Written from each command's implementation: what it does, when to use it rather than its
//! neighbours, the parameters that matter (times are ticks, 254016000000 a second, unless a key says
//! frames or seconds) and what it answers. Edit the text here.

/// The command `id`'s description.
pub fn description(id: &str) -> &'static str {
    match id {
        "audio.detectBeats" => {
            "Finds the beats of music: an audio `clip` on the timeline (times in the sequence) or a project `item` (times from its start). Answers {bpm, confidence 0–1, beats in seconds, times in ticks, frames}; speech, silence and noise are an error (no beat). `markers: true` also adds a sequence marker (`name`, `color`) on every beat as one undo step, for snapping edits to them."
        }
        "audio.bed" => {
            "Lays music under the film as one undo step: an audio `clip`, or a project `item` placed from `frame`/`seconds` (0) to the end of the picture on the first free audio track. Sets clip gain `gainDb` (−9.4, ≈0.34 linear; or `volume`) and Constant Gain fades of `fadeInSeconds` (1) and `fadeOutSeconds` (1.7); `duck` {against: dialogue (or sfx, ambience, a list), reduceDb, sensitivity, fadeSeconds} makes it Music, sets its ducking and generates the ducking keyframes. Answers {clips, audioTrack, gainDb, frames [start, end], ducking regions}."
        }
        "audio.toggleScrubbing" => "Turns audio during scrubbing on or off (the audio.scrubAudio preference). Answers {scrubAudio}.",
        "audio.voiceover.settings" => {
            "Reads or changes the Voice-Over Record Settings preferences: source device, input channel, take `name`, countdown cues, pre-roll and post-roll seconds (0–60). Answers the settings and the input devices."
        }
        "audio.voiceover.start" => {
            "Arms and starts a voice-over take at the playhead or `time` (the sequence In point when In/Out are set), on `track` or the record-armed/targeted audio track; `preroll` overrides the pre-roll. Answers the record, capture and punch-out times."
        }
        "audio.voiceover.stop" => {
            "Stops the voice-over take and, as one undo step, writes it to `<Name> n.wav` (in `dir` or the captured-media folder), imports it and places it on the record track at the record point. `discard: true` drops the take instead."
        }
        "audio.voiceover.sync" => {
            "Tells the recorder that host playback actually started at `time`, so capture restarts there and the take lands sample-accurately. Call after audio.voiceover.start once playback runs."
        }
        "captions.add" => {
            "Adds a caption on a caption track at the playhead (or `time` ticks / `seconds`), `durationSeconds` long (3 by default) with `text`, its In and Out each on the frame that shows their time; creates track C1 if the sequence has none. `words` [{text, start, end} in sequence seconds] makes a karaoke caption spanning the words: each word gets a WebVTT timestamp, Chinese/Japanese/Korean words join without spaces, and burned-in captions draw the word being sung in the track's highlight colour and scale (a pause between words highlights nothing). Inline <b>, <i>, <u> are drawn. Answers the new caption."
        }
        "captions.delete" => {
            "Deletes the listed `captions` (default: the caption selection). `ripple: true` also closes the gaps by moving later captions earlier. Answers {deleted}."
        }
        "captions.deleteTrack" => "Removes a whole caption track (`track` id or \"C1\"…, default the first) and all its captions.",
        "captions.export" => {
            "Writes a caption track to a new file at `path`; `format` srt|vtt|scc|mcc|stl|ttml|dfxp defaults from the extension (else SRT); `dropFrame` applies to SCC/MCC timecode."
        }
        "captions.goTo" => "Moves the playhead to the start of `caption` and selects it. Answers {time} in ticks.",
        "captions.hideAll" => {
            "Disables every caption track of the active sequence so none shows in the Program monitor or export; the captions stay. Reverse with captions.showAll."
        }
        "captions.import" => {
            "Reads a caption file at `path` (format detected from content and extension) into a new caption track of the active sequence; `name` names the track."
        }
        "captions.list" => {
            "Lists the caption tracks (or just `track`) with their captions' ids, times in ticks, text and speaker, plus the caption selection. Read before editing captions."
        }
        "captions.merge" => {
            "Joins consecutive captions on one track into the first: it spans from the first start to the last end, texts joined with line breaks. Answers {caption}."
        }
        "captions.move" => {
            "Shifts `captions` (default: selected) by `delta` ticks or `deltaFrames`, clamped at zero and so they don't overlap captions that stay. Answers {applied} ticks."
        }
        "captions.newTrack" => {
            "Adds a caption track of `format` Subtitle|CEA-608|CEA-708|Teletext (default Subtitle) with `name` and `language` (default en), after the existing caption tracks (C1, C2… keep their tracks). Answers the new track's id and label."
        }
        "captions.next" => "Moves the playhead to the start of the next caption on enabled caption tracks and selects it. Answers {time, caption}.",
        "captions.previous" => "Moves the playhead to the start of the previous caption on enabled caption tracks and selects it. Answers {time, caption}.",
        "captions.select" => "Selects `captions` by id (ids not in the sequence are ignored); `add: true` adds to the current caption selection.",
        "captions.setStyle" => {
            "Sets a caption track's look: font, size, color, background, align, anchor, margin (fraction of frame height, 0–0.45), line spacing, outline, and for karaoke captions `highlightColor` and `highlightScale` (0.25–4) of the word being sung; `reset` restores defaults. Applies to every caption on the track."
        }
        "captions.setText" => "Changes the `text` and/or `speaker` (null clears it) of one caption (default: the selected one).",
        "captions.setTimes" => {
            "Sets a caption's start and/or end, each as ticks (`startTime`), frames, seconds or timecode; default caption is the selected one."
        }
        "captions.setTrack" => "Changes a caption track's name, format, language, enabled, locked or sync-lock settings.",
        "captions.showActiveOnly" => "Enables only `track` (default the first) and disables the other caption tracks, so one language shows.",
        "captions.showAll" => "Enables every caption track of the active sequence. Reverse with captions.hideAll.",
        "captions.split" => {
            "Splits `caption` at `time` (default: the playhead), or every caption under the playhead on unlocked caption tracks when no caption is given. Answers the new captions."
        }
        "captions.trim" => {
            "Moves the in or out `edge` of one caption by `delta` ticks or `deltaFrames`, without moving neighbours. Use captions.setTimes to set an absolute time."
        }
        "clip.audioChannels" => {
            "Sets how project `items`' audio channels map to clips: `format` mono|stereo|5.1|adaptive and which source `channels` each clip carries. Applies to clips made after; existing timeline clips keep theirs."
        }
        "clip.audioGain" => {
            "Changes clip gain of the selected or listed audio `clips`: `mode` set (to `db`), adjust (by `db`), normalizeMax (loudest peak to `db`) or normalizeAll (each clip's peak to `db`)."
        }
        "clip.audioPeak" => "Reads the peak amplitude (dBFS) of the selected or listed audio clips at their current gain, as the Audio Gain dialog shows it.",
        "clip.automateToSequence" => {
            "Places the selected project `items` in the active sequence in `ordering` (sort or selection), sequentially or at unnumbered markers, by insert or overwrite, with optional default transitions of `overlapFrames`."
        }
        "clip.breakoutToMono" => "Creates one mono project item per audio channel of each selected item with audio, in the same bin. Answers the new items.",
        "clip.clearPosterFrame" => "Clears the poster frame of a project `item` (default selected), so its thumbnail returns to the first frame.",
        "clip.createMulticam" => {
            "Builds a multi-camera source sequence from synchronized project `items` (aligned by in, out, timecode, marker or audio), with `audio` mode and camera names from clip, track or metadata."
        }
        "clip.editOffline" => "Edits the offline-file information of an offline `item`: media name, tape name, description, scene, shot and log note.",
        "clip.editSubclip" => {
            "Changes an existing subclip `item`'s start/end (ticks or frames of its master), `restrictTrims`, or converts it back to a master clip with `convertToMaster`."
        }
        "clip.enable" => {
            "Toggles whether the selected or listed `clips` (with linked partners) play and render: all disabled when they were all enabled, else all enabled."
        }
        "clip.extractAudio" => {
            "Renders the audio of the selected clips or `items` to new audio files (in `dir`) and imports them as project items; one undo step."
        }
        "clip.fieldOptions" => {
            "Sets interlaced field handling of the selected or listed `clips`: reverse field dominance, and `processing` none|alwaysDeinterlace|flickerRemoval."
        }
        "clip.fillFrame" => {
            "Scales and centres the selected or listed video `clips` so they cover the whole frame (cropping edges). Use clip.fitToFrame to show the whole picture."
        }
        "clip.fitToFrame" => {
            "Scales and centres the selected or listed video `clips` so the whole picture is visible inside the frame (letterboxing). Use clip.fillFrame to cover the frame."
        }
        "clip.frameHold" => {
            "Splits the selected clips (or the targeted video clip under the playhead) at the playhead or `time` and freezes the frame there for the rest of the clip."
        }
        "clip.frameHoldOptions" => {
            "Turns a frame hold on or off for the selected or listed `clips` and chooses the held frame: sourceTimecode, sequenceTime, in, out or playhead; `holdFilters` also freezes effects."
        }
        "clip.generateAudioWaveform" => "Asks the host to rebuild audio waveform peaks for the selected or listed `items`; changes no project data.",
        "clip.group" => "Groups the selected clips so selecting or moving one selects or moves them all. Undo with clip.ungroup.",
        "clip.insertFrameHoldSegment" => {
            "Inserts a frozen frame `seconds` long (default 2) at the playhead or `time` inside `clip` (default the one under the playhead), splitting it and pushing the rest later."
        }
        "clip.interpretFootage" => "Sets the source color space of the selected or listed footage `items` (`colorSpace`: auto or an id from color.spaces).",
        "clip.link" => {
            "Links the selected (or listed) video and audio clips so they select and move together; if they are all already linked, unlinks them instead."
        }
        "clip.makeSubclip" => {
            "Creates a subclip project item from a master `item` or timeline `clip` between start and end (ticks or frames), default the item's In/Out; `restrictTrims` keeps edits inside that range. Answers the new item."
        }
        "clip.mergeClips" => {
            "Merges one video item and audio items, aligned by in, out, timecode, marker or audio, into a new merged project item; `removeVideoAudio` drops the camera audio."
        }
        "clip.modifyTimecode" => "Sets the start `timecode` (or `frame`) and `tapeName` of a media `item`; `reset` restores the file's own timecode.",
        "clip.multicamEnable" => "Turns multi-camera behaviour of the selected nested clips on or off (`enabled`, toggles when omitted).",
        "clip.multicamFlatten" => "Replaces the selected multi-camera clips with the clips their active angles show; the result no longer switches angles.",
        "clip.nest" => {
            "Moves the selected clips (with linked partners and their transitions) into a new nested sequence named `name` and replaces them with one clip of it."
        }
        "clip.nudgeVolumeDown1" => "Lowers the Volume level of the selected audio clips by 1 dB (keyframed levels shift as a whole).",
        "clip.nudgeVolumeDown3" => "Lowers the Volume level of the selected audio clips by 3 dB (keyframed levels shift as a whole).",
        "clip.nudgeVolumeUp1" => "Raises the Volume level of the selected audio clips by 1 dB (keyframed levels shift as a whole).",
        "clip.nudgeVolumeUp3" => "Raises the Volume level of the selected audio clips by 3 dB (keyframed levels shift as a whole).",
        "clip.remix" => {
            "Remixes an audio `clip` (default selected) to a target length (`duration` ticks, `seconds`, `frame` or `timecode`) by cutting and crossfading its musical segments, enabling remix first if needed. Answers the plan."
        }
        "clip.remix.enable" => {
            "Analyses the selected audio `clip` and makes it a remix clip at its current duration, so its length can later be changed with clip.remix."
        }
        "clip.remix.properties" => "Without parameters reads a remix clip's settings; with a target duration, `segments` or `variations` re-plans the remix.",
        "clip.remix.revert" => "Restores a remix `clip` to how it was before remixing.",
        "clip.rename" => "Renames a timeline `clip` (default the first selected) or a project `item` to `name`.",
        "clip.replaceFromBin" => {
            "Replaces the source of the selected or listed `clips` with project `item`, keeping position and length; `keepSourceIn` keeps the old In point instead of the new item's."
        }
        "clip.replaceFromSource" => "Replaces the source of the selected clips with the clip open in the Source monitor, starting at its In point.",
        "clip.replaceFromSourceMatchFrame" => {
            "Replaces the selected clips with the Source monitor clip so its frame at the Source playhead lines up with the sequence playhead."
        }
        "clip.restoreCaptionsFromSource" => "Restores embedded captions from source media; always refused, since no embedded caption reader exists.",
        "clip.revealInProject" => {
            "Selects and shows in the Project panel the source item of `clip` (default the selected or topmost targeted clip under the playhead)."
        }
        "clip.scaleToFrameSize" => "Toggles Scale to Frame Size on the selected clips: rendered at the frame size rather than their native resolution.",
        "clip.sceneEditDetection" => {
            "Detects shot changes in the selected video `clips` (`sensitivity` 0–100, minimum shot `minShotFrames`) and cuts there, and/or makes subclips or markers; `wait` blocks until analysis ends."
        }
        "clip.setPosterFrame" => "Sets a project `item`'s poster (thumbnail) frame to `time` or its Source playhead.",
        "clip.setTimeInterpolation" => "Sets how the selected or listed `clips` render changed speed: `mode` frameSampling, frameBlending or opticalFlow.",
        "clip.sourceSettings" => "Reads the source settings of a media `item` (codec-specific decode options) as Clip ▸ Source Settings shows them.",
        "clip.speedDuration" => {
            "Changes the selected or listed `clips`' `speed` in percent (100 = normal; length scales by 100/speed), `reverse`, `ripple` (move later clips) and time `interpolation`."
        }
        "clip.synchronize" => {
            "Aligns the selected timeline clips to a `reference` clip by in, out, timecode, a named clip `marker` or audio waveform, plus `offset` frames."
        }
        "clip.timeInterpolation.frameBlending" => {
            "Sets the selected clips' time interpolation to Frame Blending (blends neighbouring frames when speed changes)."
        }
        "clip.timeInterpolation.frameSampling" => {
            "Sets the selected clips' time interpolation to Frame Sampling (repeats or drops whole frames when speed changes)."
        }
        "clip.timeInterpolation.opticalFlow" => {
            "Sets the selected clips' time interpolation to Optical Flow (synthesises in-between frames when speed changes)."
        }
        "clip.ungroup" => "Removes the selected clips from their groups.",
        "clip.updateMetadata" => "Writes the selected file `items`' metadata to XMP sidecar files next to the media.",
        "clip.volumeDown" => "Lowers the Volume level of the selected audio clips by 1 dB.",
        "clip.volumeDownMany" => "Lowers the Volume level of the selected audio clips by the Large Volume Adjustment preference.",
        "clip.volumeUp" => "Raises the Volume level of the selected audio clips by 1 dB.",
        "clip.volumeUpMany" => "Raises the Volume level of the selected audio clips by the Large Volume Adjustment preference.",
        "clipMixer.release" => {
            "Lets go of an Audio Clip Mixer fader or pan control on `track` at `time` (default playhead), ending a Latch/Touch automation pass for that lane."
        }
        "clipMixer.set" => {
            "Sets a clip's audio effect parameter (default Volume ▸ Level) to `value` at `time` (default playhead); `keyframe: true` writes a keyframe, otherwise the static value. Consecutive calls on the same control are one undo step."
        }
        "clipMixer.setMode" => {
            "Sets the Audio Clip Mixer automation mode of an audio `track`: Off, Read, Latch, Touch or Write. Not undoable; mixer state only."
        }
        "clipMixer.touch" => {
            "Moves an Audio Clip Mixer control (`lane` volume or pan) on `track` to `value` at `time`, recording keyframes on the clip under it per the track's automation mode."
        }
        "color.spaces" => "Lists the color space ids that clip.interpretFootage and sequence color settings accept.",
        "command.list" => "Lists every command with id, title, menu path, shortcut, parameters and whether it is enabled now.",
        "edit.clear" => {
            "Deletes the selected (or listed `clips`) timeline clips with their linked partners, leaving gaps; with no clip selected it deletes the selected captions. Use edit.rippleDelete to close the gaps."
        }
        "edit.consolidateDuplicates" => {
            "Merges project items that refer to the same file or generator with the same interpretation: the oldest is kept and every clip using the others is relinked to it."
        }
        "edit.copy" => {
            "Copies the selected timeline clips (with their tracks, offsets and markers) to the clipboard for edit.paste/pasteInsert/pasteAttributes. Answers {copied}."
        }
        "edit.cut" => "Copies the selected clips (with linked partners) to the clipboard and deletes them, leaving gaps.",
        "edit.deselectAll" => "Clears the timeline clip and caption selection.",
        "edit.duplicate" => "Duplicates the selected Project panel items as new items named \"<name> Copy\" in the same bin. Answers the new item ids.",
        "edit.editOriginal" => {
            "Answers the media file paths of the selected clips or `items` so the host opens them in their original applications; changes nothing."
        }
        "edit.find" => {
            "Finds project items (`scope` project) or timeline clips (timeline) by `column` and `operator` with `text`, or several `rows` (`matchAll`); selects and reveals the first match. Answers it and the match count."
        }
        "edit.findNext" => "Selects and reveals the next match of the last edit.find search. Needs a previous edit.find.",
        "edit.label" => "Sets the color `label` (Violet, Iris, Caribbean…) of the selected timeline clips and Project panel items.",
        "edit.label.blue" => "Sets the Blue color label on the selected (or listed `clips`) timeline clips and Project panel (`items`) items.",
        "edit.label.brown" => "Sets the Brown color label on the selected (or listed `clips`) timeline clips and Project panel (`items`) items.",
        "edit.label.caribbean" => "Sets the Caribbean color label on the selected (or listed `clips`) timeline clips and Project panel (`items`) items.",
        "edit.label.cerulean" => "Sets the Cerulean color label on the selected (or listed `clips`) timeline clips and Project panel (`items`) items.",
        "edit.label.forest" => "Sets the Forest color label on the selected (or listed `clips`) timeline clips and Project panel (`items`) items.",
        "edit.label.green" => "Sets the Green color label on the selected (or listed `clips`) timeline clips and Project panel (`items`) items.",
        "edit.label.iris" => "Sets the Iris color label on the selected (or listed `clips`) timeline clips and Project panel (`items`) items.",
        "edit.label.lavender" => "Sets the Lavender color label on the selected (or listed `clips`) timeline clips and Project panel (`items`) items.",
        "edit.label.magenta" => "Sets the Magenta color label on the selected (or listed `clips`) timeline clips and Project panel (`items`) items.",
        "edit.label.mango" => "Sets the Mango color label on the selected (or listed `clips`) timeline clips and Project panel (`items`) items.",
        "edit.label.purple" => "Sets the Purple color label on the selected (or listed `clips`) timeline clips and Project panel (`items`) items.",
        "edit.label.rose" => "Sets the Rose color label on the selected (or listed `clips`) timeline clips and Project panel (`items`) items.",
        "edit.label.tan" => "Sets the Tan color label on the selected (or listed `clips`) timeline clips and Project panel (`items`) items.",
        "edit.label.teal" => "Sets the Teal color label on the selected (or listed `clips`) timeline clips and Project panel (`items`) items.",
        "edit.label.violet" => "Sets the Violet color label on the selected (or listed `clips`) timeline clips and Project panel (`items`) items.",
        "edit.label.yellow" => "Sets the Yellow color label on the selected (or listed `clips`) timeline clips and Project panel (`items`) items.",
        "edit.paste" => {
            "Pastes the clipboard's clips at the playhead on their original track layout, overwriting what is there; nothing moves. Use edit.pasteInsert to push later clips right."
        }
        "edit.pasteAttributes" => {
            "Pastes the copied clip's motion, opacity, time remapping, volume, channel volume, panner and `effects` (true or a list of effect ids) onto the selected or listed `clips`; `scaleTimes` fits keyframes to each clip's length."
        }
        "edit.pasteInsert" => {
            "Pastes the clipboard's clips at the playhead as an insert: clips at and after the playhead move right by the pasted length on the affected tracks."
        }
        "edit.redo" => "Redoes the last undone step in `scope` (person or agent; default the caller's own). Answers {redone} with the step's label.",
        "edit.removeAttributes" => {
            "Removes motion, opacity, time remapping, volume, channel volume, panner and/or `effects` from the selected or listed `clips`, resetting them to defaults."
        }
        "edit.removeUnused" => "Deletes every project item that no sequence uses (sequences and bins are kept). Answers {removed} item ids.",
        "edit.rippleDelete" => {
            "Deletes the selected (or listed `clips`) clips and closes the gaps by moving later clips earlier; refused when nothing can close. With no clip selected it ripple-deletes the selected captions."
        }
        "edit.selectAll" => "Selects every clip on every track of the active sequence. Answers {selected}.",
        "edit.selectAllMatching" => {
            "Selects every clip in the active sequence that uses the same source item as the selected (or listed) clips. Answers {clips}."
        }
        "edit.selectLabelGroup" => {
            "Selects every timeline clip (or Project panel item, when no clip is selected) with the same color label as the current selection."
        }
        "edit.undo" => {
            "Undoes the last step in `scope` (person or agent; default the caller's own), so an agent's undo never takes back the person's edit. Answers {undone} with the step's label."
        }
        "effects.addKeyframe" => {
            "Adds a keyframe of an effect parameter at `time` (sequence ticks, default playhead) with its current value, or removes it if one is there. `mask` targets a mask's parameter."
        }
        "effects.apply" => {
            "Adds `effect` (id like gaussian_blur or its name; see effects.list) to the selected or listed `clips`, at the end of each clip's effect stack."
        }
        "effects.deleteKeyframe" => {
            "Deletes the keyframe of an effect parameter at `mediaTime` (ticks of the clip's media time, as sequence.inspect lists each keyframe's `mediaTime`). `mask` targets a mask's parameter."
        }
        "effects.list" => {
            "Lists available effects and transitions (filter by `kind` Video, Audio, VideoTransition, AudioTransition, `folder`, or one `effect` by id or name, the exact id first) with ids; `detail` (implied by `effect`) adds `paramInfo`: each parameter's id, type, default, min / max / unit, choice `options`, and `accepts` (the values it takes, e.g. booleans for an amount, left/right/up/down for a direction). Read to find effect ids and transition `params`."
        }
        "effects.moveKeyframe" => {
            "Moves the keyframe of an effect parameter at `mediaTime` to media time `to` (both clip media ticks). `mask` targets a mask's parameter."
        }
        "effects.remove" => "Removes the effect at `index` (0-based, as sequence.inspect lists a clip's effects; fixed effects can't be removed) from `clip`.",
        "effects.reset" => "Resets every parameter of the effect at `index` of `clip` to its defaults.",
        "effects.move" => {
            "Moves the standard effect at `index` of `clip` to index `to` (0-based, as sequence.inspect lists a clip's effects), changing the order it renders in; fixed effects (Motion, Opacity, Volume…) and graphic layers keep their places."
        }
        "effects.setDefaultTransition" => {
            "Sets the default video or audio transition used by sequence.applyVideoTransition/applyAudioTransition and default-transition commands."
        }
        "effects.setInterpolation" => {
            "Sets the interpolation of the keyframe at `mediaTime`: linear, bezier, autoBezier, continuousBezier, hold, easeIn or easeOut (an unknown name is refused). `mask` targets a mask's parameter."
        }
        "effects.setKeyframe" => "Changes the keyframe at `mediaTime`: its `value` and bezier in/out influence (0–1). `mask` targets a mask's parameter.",
        "effects.setParam" => {
            "Sets `param` of `clip`'s `effect` (\"motion\", \"opacity\", a name or index) to `value`. With a `time` (sequence ticks; or `frame`, `seconds`, `timecode`) it sets a keyframe there, turning animation on if the parameter was static; without one it keys the playhead when the parameter is animated, else sets the static value. `param` is a parameter id or label, and a choice takes its option's name (any case) or index. `mask` targets a mask's parameter (a mask `path` in frame pixels). Motion's `scale_width` needs `uniform_scale` false (it is refused while Uniform Scale is on). `merge: true` makes a drag of this parameter one undo step; `merge` with a name makes every call with that name on the clip one undo step (a drag that changes several parameters); `begin` starts a new step."
        }
        "effects.toggleAnimation" => {
            "Turns keyframe animation of an effect parameter on (a keyframe at `time`, sequence ticks or `frame`/`seconds`, default the playhead) or off (removes its keyframes, keeping the value at that time)."
        }
        "effects.toggleEnabled" => "Turns the effect at `index` of `clip` on or off without removing it.",
        "audioMixing.applyPreset" => "Applies audio mixing `preset` to the selected or listed `clips` (for audio `type`).",
        "audioMixing.autoMatch" => "Sets the clip gain of the selected or listed dialogue `clips` so each measures `target` LUFS (default -23).",
        "audioMixing.clearType" => "Clears the audio type of the selected or listed `clips`, removing their audio mixing effects.",
        "audioMixing.deletePreset" => "Deletes saved audio mixing preset `name`.",
        "audioMixing.generateDucking" => {
            "Writes volume keyframes on the selected music `clips` that duck them under dialogue clips, per their ducking settings."
        }
        "audioMixing.inspect" => {
            "Reads the audio mixing settings of the selected or listed audio `clips`: type, repair, clarity, creative, ducking and loudness."
        }
        "audioMixing.savePreset" => "Saves the audio mixing settings of the first selected or listed clip as preset `name`.",
        "audioMixing.set" => {
            "Sets an audio mixing control (`key` like repair.noise.amount, clarity.eqPreset, ducking.reduceDb, volume.levelDb) to `value`, or several `values`, on the selected or listed `clips`."
        }
        "audioMixing.setType" => {
            "Sets the audio type of the selected or listed `clips`: dialogue, music, sfx or ambience, which decides the audio mixing controls."
        }
        "events.clear" => "Clears every entry from the session's event log.",
        "events.list" => "Lists the session's event log (warnings, errors, info) at or above `level`, newer than `since`.",
        "export.formats" => "Lists the export formats with their codecs, containers and supported options.",
        "export.presets.delete" => "Deletes user export preset `name`.",
        "export.presets.export" => "Writes user export presets (`names`, default all) to a preset file at `path`.",
        "export.presets.favorite" => "Marks export preset `name` as a favorite or not.",
        "export.presets.get" => "Reads export preset `name`'s full settings.",
        "export.presets.import" => "Reads export presets from the preset file at `path` into the user library.",
        "export.presets.list" => "Lists export presets (built-in and user), filtered by `query`, `category`, `format` or `favorites`.",
        "export.presets.save" => "Saves a user export preset `name` from another preset (`from`) or `settings` plus overrides; overwrites by default.",
        "export.queue.add" => {
            "Adds an export of the active (or given) sequence with a preset or settings and output path to the export queue; start it with export.queue.start."
        }
        "export.queue.cancel" => "Cancels queued or running export `id` (default the running one).",
        "export.queue.clear" => "Removes finished exports from the queue (`all` also removes failed and cancelled ones).",
        "export.queue.list" => "Lists the export queue: each job's id, sequence, output path, status and progress.",
        "export.queue.move" => "Moves queued export `id` to position `to` or by `by` places.",
        "export.queue.remove" => "Removes export `id` from the queue.",
        "export.queue.retry" => "Re-queues failed or cancelled export `id`; `start` starts the queue.",
        "export.queue.start" => "Starts encoding the queued exports in order; `wait` blocks until the queue finishes.",
        "export.queue.stop" => "Pauses the export queue after the current job.",
        "export.quick" => {
            "Exports the active sequence immediately with `preset` (default the Quick Export preset) to `path` (default next to the project); `wait` blocks."
        }
        "export.resolve" => "Answers the full export settings a preset plus overrides would use, and the output path, without exporting.",
        "file.autoSaveNow" => "Writes an auto-save of the current project immediately (desktop sessions with auto-save running). Answers the file written.",
        "file.autoSaveStatus" => "Reads the auto-save state: whether it runs, its preferences, data folder and the last save time.",
        "file.close" => "Closes the active sequence's timeline tab (or `item`'s), like File ▸ Close; the project stays open.",
        "file.closeAllOtherProjects" => "Closes every other open project; always refused, since a session holds one project.",
        "file.closeAllProjects" => "Closes the project, as file.closeProject; `force` discards unsaved changes.",
        "file.closeProject" => "Closes the project; refused with unsaved changes unless `force` discards them.",
        "file.discardRecovery" => "Deletes recoverable unsaved sessions: one by `id`, or `all`.",
        "file.exportAaf" => {
            "Writes the active (or `sequence`) sequence as AAF at `path` for Avid/Pro Tools, with audio embedded or separate, sample rate, bit depth, handles and optional video mixdown."
        }
        "file.exportAle" => "Writes an Avid Log Exchange (ALE) file at `path` listing the selected or listed media `items` with their metadata.",
        "file.exportEdl" => "Writes the active sequence as a CMX 3600 EDL at `path` (video track V1 and its edits).",
        "file.exportFcp7Xml" => "Writes the active sequence as Final Cut Pro 7 XML at `path` (Premiere/Resolve interchange).",
        "file.exportFcpxml" => "Writes the active sequence as FCPXML at `path` for Final Cut Pro.",
        "file.exportFrame" => {
            "Writes one frame to an image file at `path` (`format` png|jpeg|tiff|bmp, `depth` 8 or 16) from the program (or Source monitor with target \"source\") at `time`; `import` adds it to the project."
        }
        "file.exportGraphicsTemplate" => {
            "Writes graphic `clip` as a Motion Graphics Template named `name` in `category`, exposing the listed `controls` (layer parameters) as editable fields."
        }
        "file.exportInterchange" => {
            "Writes the active (or `sequence`) sequence in an interchange `format`: edl, xml (FCP7), fcpxml, otio, aaf or omf, at `path`."
        }
        "file.exportMedia" => {
            "Renders the active sequence (In–Out when set) to a media file at `path`: `format` (h264, hevc, prores, dnxhr, png, wav…), size, fps, bitrate, quality, captions, loudness; or a `preset`. For H.264 a `quality` (0–100) without `bitrateKbps` or `bitrateMode` encodes at constant quality (CRF 51 at 0 to 12 at 100; 90 is CRF 15.9); otherwise the bitrate settings apply. Long jobs run in the background."
        }
        "file.exportOmf" => {
            "Writes the active (or `sequence`) sequence's audio as OMF at `path` for Pro Tools, embedded or separate audio, sample rate, bit depth, handles."
        }
        "file.exportOtio" => "Writes the active sequence as OpenTimelineIO (.otio) at `path`.",
        "file.exportSelectionProject" => "Writes the selected or listed project `items` (and what they use) as a new Kition Film project at `path`.",
        "file.import" => {
            "Imports media files at `paths` into the project (into `bin` when given); `imageSequence` treats numbered stills as one clip. Answers the new item ids."
        }
        "file.importAaf" => "Imports an AAF (or OMF) file at `path` as new sequences with their media.",
        "file.importDemoFootage" => {
            "Adds generated demo footage items (`scene` OceanSunset, Aurora, CityNight, Dunes, Plasma or Forest; all when omitted) to the project."
        }
        "file.importFromMediaBrowser" => "Imports the Media Browser's selected files, or `paths`; `imageSequence` treats numbered stills as one clip.",
        "file.importImageSequence" => "Imports numbered stills starting at `path` (the first still) as one image-sequence clip, into `bin`.",
        "file.listAutoSaves" => "Lists the auto-save files of the current project, newest first, with their folder.",
        "file.mediaProperties" => "Reads media file properties (codec, size, frame rate, streams, duration, timecode) of the selected or listed `items`.",
        "file.mediaPropertiesFile" => "Reads media file properties of the file at `path` without importing it.",
        "file.newAdjustmentLayer" => {
            "Creates an Adjustment Layer project item `seconds` long (default 5) at the active sequence's frame size; effects on it apply to the tracks below."
        }
        "file.newBarsAndTone" => "Creates an SMPTE bars and 1 kHz tone generator item `seconds` long (default 10).",
        "file.newBin" => "Creates a bin `name` (default New Bin) in bin `parent` (default root). Answers the new bin id.",
        "file.newBinFromSelection" => "Creates a bin named `name` and moves the selected or listed `items` into it.",
        "file.newBlackVideo" => "Creates a black video generator item `seconds` long.",
        "file.newColorMatte" => "Creates a solid Color Matte item of `color` #rrggbb, `seconds` long.",
        "file.newCountingLeader" => "Creates a Universal Counting Leader generator item (an 8-second countdown).",
        "file.newOfflineFile" => {
            "Creates an offline placeholder item with name, file and tape names, video/audio format, timecode and duration, to relink later."
        }
        "file.newProject" => "Replaces the current project with a new empty one named `name`; unsaved changes are not kept.",
        "file.newProjectFromTemplate" => "Creates a new project from `template` (a saved template name or path) named `name`.",
        "file.newSearchBin" => "Creates a search bin `name` that live-matches items by `column`/`operator`/`text` (or `rows` with `matchAll`).",
        "file.newSequence" => {
            "Creates a sequence `name` (default 1920×1080, 23.976 fps, 48 kHz, 3 video and 3 audio tracks, or from `item`'s format) and opens it. Answers the new sequence id."
        }
        "file.newSequenceFromClip" => {
            "Creates a sequence matching the format of each selected or listed clip `items` with that clip placed on it, and opens it."
        }
        "file.newTransparentVideo" => "Creates a Transparent Video generator item (an empty clip for effects that draw their own content).",
        "file.open" => "Opens the project file at `path`, replacing the current project.",
        "file.openDemoProject" => "Replaces the current project with the built-in demo project and opens its sequence.",
        "file.projectManager" => {
            "Copies (collect) or trims and transcodes (consolidate) the `sequences` and their media to `destination` as a new project, with `handles` frames; `dryRun` only reports. Long jobs run in the background."
        }
        "file.projectSettings.general" => {
            "Changes General project settings: renderer, video and audio time display, capture format, title/action safe margins."
        }
        "file.projectSettings.scratchDisks" => "Sets the folders for captured media, video previews, audio previews and auto-saves (null resets to default).",
        "file.recover" => "Loads a recoverable unsaved session (`id`, default newest) as the current unsaved project.",
        "file.recoveryList" => "Lists recoverable unsaved sessions left by crashes or closed windows.",
        "file.replaceFonts" => "Replaces font `from` (family, optional style) with `to` in every graphic and caption in the project.",
        "file.revert" => "Reloads the project from its last saved file, discarding changes since. Needs a saved project.",
        "file.save" => "Saves the project to its file (or `path`). Needs a path once; use file.saveAs for a new file.",
        "file.saveAll" => "Saves the project, as file.save.",
        "file.saveAs" => "Saves the project to `path` and makes that the project's file from now on.",
        "file.saveAsTemplate" => "Saves the project as a reusable template `name` (or at `path`).",
        "file.saveCopy" => "Writes a copy of the project to `path`; the project keeps its own file.",
        "file.templates" => "Lists the saved project templates.",
        "fonts.list" => "Lists the available font families and styles (bundled plus system fonts when `system`).",
        "graphics.align" => {
            "Aligns graphic `layers` (default selected) of a graphic clip `left|hcenter|right|top|vcenter|bottom`, relative to the `frame`, their union (`group`) or the selection."
        }
        "graphics.alignFrame.bottom" => "Aligns the bottom edges of the selected graphic layers to the frame.",
        "graphics.alignFrame.hcenter" => "Aligns the horizontal centres of the selected graphic layers to the frame.",
        "graphics.alignFrame.left" => "Aligns the left edges of the selected graphic layers to the frame.",
        "graphics.alignFrame.right" => "Aligns the right edges of the selected graphic layers to the frame.",
        "graphics.alignFrame.top" => "Aligns the top edges of the selected graphic layers to the frame.",
        "graphics.alignFrame.vcenter" => "Aligns the vertical centres of the selected graphic layers to the frame.",
        "graphics.alignGroup.bottom" => "Aligns the bottom edges of the selected graphic layers to their combined bounds.",
        "graphics.alignGroup.hcenter" => "Aligns the horizontal centres of the selected graphic layers to their combined bounds.",
        "graphics.alignGroup.left" => "Aligns the left edges of the selected graphic layers to their combined bounds.",
        "graphics.alignGroup.right" => "Aligns the right edges of the selected graphic layers to their combined bounds.",
        "graphics.alignGroup.top" => "Aligns the top edges of the selected graphic layers to their combined bounds.",
        "graphics.alignGroup.vcenter" => "Aligns the vertical centres of the selected graphic layers to their combined bounds.",
        "graphics.alignSelection.bottom" => "Aligns the bottom edges of the selected graphic layers to the selection's bounds.",
        "graphics.alignSelection.hcenter" => "Aligns the horizontal centres of the selected graphic layers to the selection's bounds.",
        "graphics.alignSelection.left" => "Aligns the left edges of the selected graphic layers to the selection's bounds.",
        "graphics.alignSelection.right" => "Aligns the right edges of the selected graphic layers to the selection's bounds.",
        "graphics.alignSelection.top" => "Aligns the top edges of the selected graphic layers to the selection's bounds.",
        "graphics.alignSelection.vcenter" => "Aligns the vertical centres of the selected graphic layers to the selection's bounds.",
        "graphics.alignTextCenter" => "Center-aligns the text of the selected graphic text layers.",
        "graphics.alignTextLeft" => "Left-aligns the text of the selected graphic text layers.",
        "graphics.alignTextRight" => "Right-aligns the text of the selected graphic text layers.",
        "graphics.arrangeLayer" => "Moves a graphic `layer` (default selected) in paint order: front, back, forward, backward, or to an index (0 = bottom).",
        "graphics.bringForward" => "Moves the selected graphic layer one step up in paint order.",
        "graphics.bringToFront" => "Moves the selected graphic layer to the top of the paint order.",
        "graphics.deleteLayer" => "Deletes graphic `layer` (default the selected or frontmost) from graphic `clip`; the clip stays.",
        "graphics.distribute" => {
            "Spaces 3 or more graphic `layers` evenly along `axis` horizontal|vertical: equal centre spacing, or equal gaps with `space: true`."
        }
        "graphics.distributeHorizontally" => "Spaces the selected graphic layers (3 or more) with equal horizontal centre spacing.",
        "graphics.distributeSpaceHorizontally" => "Spaces the selected graphic layers (3 or more) with equal horizontal gaps between them.",
        "graphics.distributeSpaceVertically" => "Spaces the selected graphic layers (3 or more) with equal vertical gaps between them.",
        "graphics.distributeVertically" => "Spaces the selected graphic layers (3 or more) with equal vertical centre spacing.",
        "graphics.fontSizeDown" => "Decreases the font size of the selected text layers by 1 px.",
        "graphics.fontSizeDown5" => "Decreases the font size of the selected text layers by 5 px.",
        "graphics.fontSizeUp" => "Increases the font size of the selected text layers by 1 px.",
        "graphics.fontSizeUp5" => "Increases the font size of the selected text layers by 5 px.",
        "graphics.fonts.used" => "Lists the font families and styles used by graphics and captions in the project, and whether each is installed.",
        "graphics.leadingDown" => "Decreases line spacing (leading) of the selected text layers by 1.",
        "graphics.leadingDown5" => "Decreases line spacing (leading) of the selected text layers by 5.",
        "graphics.leadingUp" => "Increases line spacing (leading) of the selected text layers by 1.",
        "graphics.leadingUp5" => "Increases line spacing (leading) of the selected text layers by 5.",
        "graphics.list" => {
            "Lists the layers of graphic `clip` (default targeted) in paint order with index, kind, name, text and properties. Read before editing a graphic."
        }
        "graphics.newEllipse" => {
            "Adds an ellipse shape layer `size` [w,h] (default 400×200) at `position` to graphic `clip`, or a new graphic clip at the playhead."
        }
        "graphics.newFromFile" => "Imports the image or video at `path` and places it as a clip above the clips at the playhead or `time` (on `track`).",
        "graphics.newPolygon" => {
            "Adds a polygon shape layer with `sides` (default 6), `size` and `position` to graphic `clip`, or a new graphic clip at the playhead."
        }
        "graphics.newRectangle" => {
            "Adds a rectangle shape layer `size` [w,h] (default 400×200) at `position` to graphic `clip`, or a new graphic clip at the playhead."
        }
        "graphics.newShape" => {
            "Adds a shape layer (`shape` rectangle|ellipse|polygon|path with `points`) to graphic `clip`, or a new graphic clip `seconds` long at the playhead. `position` and the path's `points` are frame pixels; a path without `position` sits at the centre of its points."
        }
        "graphics.newText" => {
            "Adds a text layer with `text`, `size` px, font and `position` (point text) or `box` [w,h] (paragraph text) to graphic `clip`, or a new graphic clip `seconds` long at the playhead (`newClip`). Answers the clip and layer."
        }
        "graphics.newVerticalText" => {
            "Adds a vertical text layer (top-to-bottom) with `text` and `size` to graphic `clip`, or a new graphic clip at the playhead."
        }
        "graphics.nudgeDown" => "Moves the selected graphic layers (or the selected video clips' Motion position) down 1 px.",
        "graphics.nudgeDown5" => "Moves the selected graphic layers (or the selected video clips' Motion position) down 5 px.",
        "graphics.nudgeLeft" => "Moves the selected graphic layers (or the selected video clips' Motion position) left 1 px.",
        "graphics.nudgeLeft5" => "Moves the selected graphic layers (or the selected video clips' Motion position) left 5 px.",
        "graphics.nudgeRight" => "Moves the selected graphic layers (or the selected video clips' Motion position) right 1 px.",
        "graphics.nudgeRight5" => "Moves the selected graphic layers (or the selected video clips' Motion position) right 5 px.",
        "graphics.nudgeUp" => "Moves the selected graphic layers (or the selected video clips' Motion position) up 1 px.",
        "graphics.nudgeUp5" => "Moves the selected graphic layers (or the selected video clips' Motion position) up 5 px.",
        "graphics.pin" => {
            "Responsive position: pins graphic `layer`'s `edges` to the frame or another layer (`to`), so it follows when that resizes; `to: none` unpins."
        }
        "graphics.resetAllParameters" => "Resets every property of the graphic `layers` (default selected, else all) to defaults.",
        "graphics.resetDuration" => "Sets graphic `clip`'s length back to `seconds` (default 5), limited by the next clip on the track.",
        "graphics.selectLayer" => "Selects graphic `layers` by index in graphic `clip`; `keepSelection` leaves the clip selection as it is.",
        "graphics.selectNextGraphic" => "Selects the next graphic clip in the sequence after the current one.",
        "graphics.selectNextLayer" => "Selects the next layer of the targeted graphic clip, cycling.",
        "graphics.selectPreviousGraphic" => "Selects the previous graphic clip in the sequence.",
        "graphics.selectPreviousLayer" => "Selects the previous layer of the targeted graphic clip, cycling.",
        "graphics.sendBackward" => "Moves the selected graphic layer one step down in paint order.",
        "graphics.sendToBack" => "Moves the selected graphic layer to the bottom of the paint order.",
        "graphics.set" => {
            "Sets properties of graphic `layer` (default selected) in `clip`: `props` like font, size, align, tracking, leading, fill_color, stroke, background, shadow, position, scale, rotation, opacity; keyframed at `time` when animated."
        }
        "graphics.setCharStyle" => {
            "Styles characters `start`–`end` of a text layer: font, size, color, bold, italic, underline, tracking, baseline shift, caps; `clear` removes run styles from the range."
        }
        "graphics.setResponsiveTime" => {
            "Sets a graphic clip's protected intro and outro (`introFrames`/`outroFrames` or seconds) that keep their timing when the clip is trimmed."
        }
        "graphics.setRoll" => {
            "Makes a graphic clip roll (credits) or crawl left/right with start/end off screen and preroll, ease and postroll frames; `mode: off` stops it."
        }
        "graphics.setText" => {
            "Replaces the text of graphic text `layer` (index or name; default selected) in `clip`; `merge` joins it with the previous Edit Text undo step."
        }
        "graphics.setTextType" => "Converts a text layer to `point` text (scales with handles) or `paragraph` text (wraps in a resizable box).",
        "graphics.template.apply" => {
            "Places a graphics template (`template` id, name or path) as a new graphic clip at the playhead or `time` on `track`, setting `values` of its controls."
        }
        "graphics.template.controls" => "Lists the editable controls of the template on graphic `clip`, with ids, kinds and current values.",
        "graphics.template.export" => {
            "Writes graphic `clip` as a reusable template named `name` exposing the listed `controls` (layer parameters) as editable fields."
        }
        "graphics.template.install" => "Installs a graphics template file (.fcgt) at `path` into the user template library; .mogrt packages are refused.",
        "graphics.template.list" => "Lists built-in and user graphics templates, filtered by `query`, `category` or `source`.",
        "graphics.template.remove" => "Removes a user graphics template by id or name from the library.",
        "graphics.template.set" => "Sets a template control (`control` id or name to `value`, or several `values`) on graphic `clip`.",
        "graphics.template.thumbnail" => "Renders a thumbnail PNG of graphics `template`, `width` px wide (default 320). Answers base64 PNG and size.",
        "graphics.upgradeCaption" => {
            "Converts `captions` (default selected, else the one under the playhead) into graphic clips with the same text and timing."
        }
        "graphics.upgradeToSourceGraphic" => "Turns graphic `clip` into a source graphic project item, so several clips can share and update it.",
        "help.systemReport" => "Reads what this build supports: OS, CPU, decoders, containers and export formats.",
        "history.list" => "Lists the undo history: each step's label, who made it (person or agent) and which steps can be undone or redone.",
        "jobs.cancel" => "Cancels background `job` by id.",
        "jobs.list" => "Lists background jobs (exports, proxies, analysis, renders) with id, kind, status and progress.",
        "color.applyMatch" => {
            "Color-matches `clip` (default selected) to the reference frame at `referenceTime`/frame/timecode in the sequence, writing Color effect corrections; `faceDetection` weights skin tones."
        }
        "color.applyPreset" => "Applies color preset `name` to the selected or listed `clips` as a Color effect.",
        "color.presetThumbnails" => {
            "Renders thumbnails of color presets (`folder` or `names`) applied to the program frame at the playhead, `width` px wide in `columns`, written as a PNG to `path`; with no sequence open, to a sample picture. Answers `source` (program or sample) and the grid's size."
        }
        "color.presets" => "Lists color presets (and `.cube` looks) in `folder`.",
        "color.setInputLut" => {
            "Sets the Input LUT of `clip`'s Color effect to an installed `lut` (lib:/builtin: id) or a .cube file at `path`; \"\" clears it."
        }
        "color.setLook" => "Sets the Creative Look of `clip`'s Color effect to an installed `lut` (lib:/builtin: id) or a file at `path`; \"\" clears it.",
        "color.setSection" => "Turns a Color effect `section` (basic, creative, curves, wheels, hsl, vignette) of `clip` on or off.",
        "lut.export" => "Writes installed `lut` to a file at `path` in `format` cube or 3dl.",
        "lut.import" => "Installs the LUT file at `path` (cube, 3dl…) into the LUT library as `name`.",
        "lut.list" => "Lists the LUTs installed for the Color effect's Input LUT and Creative Look.",
        "lut.remove" => "Uninstalls LUT `id` from the LUT library; clips that use it keep a copy.",
        "markers.add" => {
            "Adds a marker at the playhead or `time` (ticks; or `frame`, `timecode`, or `seconds`, on the frame that shows that time) with `name`, `comment`, `color` (a marker colour: Red, Orange, Yellow, Green, Cyan, Blue, Purple, or a label name; it reads back as the marker colour, Red for Rose; an unknown colour is refused) and optional `durationFrames` or `durationSeconds` (a range marker), on the sequence or, with target \"source\", the Source monitor clip. Answers the marker id."
        }
        "markers.addChapter" => {
            "Adds a chapter marker (exported as a chapter in MP4/DVD) at the playhead or `time` (or `frame`, `seconds`, `timecode`); named Chapter n by default."
        }
        "markers.addFlashCue" => {
            "Adds a Flash Cue marker (an event cue for interactive exports) at the playhead or `time` (or `frame`, `seconds`, `timecode`)."
        }
        "markers.addRange" => {
            "Adds a range marker starting at the playhead or `time` (or `frame`, `seconds`, `timecode`), `durationFrames` or `durationSeconds` long (1 second by default) or `duration` ticks."
        }
        "markers.addRangeInOut" => "Adds a range marker spanning the sequence In to Out points. Needs both In and Out set.",
        "markers.clearAll" => "Removes every marker from the sequence (or the Source clip with target \"source\").",
        "markers.clearCurrent" => "Removes the marker that starts exactly at the playhead.",
        "markers.clearIn" => "Clears the In point (including split video/audio Ins) of the sequence or Source clip.",
        "markers.clearInOut" => "Clears both In and Out points (and any split edits) of the sequence or Source clip.",
        "markers.clearOut" => "Clears the Out point (including split video/audio Outs) of the sequence or Source clip.",
        "markers.copyPasteIncludesSequenceMarkers" => {
            "Sets whether copying and pasting clips also carries the sequence markers over them (`on`, toggles when omitted)."
        }
        "markers.edit" => {
            "Changes a marker by id (`marker`): name, comment, `color` (a marker colour or label name), `durationFrames`/`durationSeconds` (0 makes it a point marker), or where a sequence marker starts (`time`, ticks; a Source marker keeps its time)."
        }
        "markers.filterColors" => {
            "Hides or shows marker colors in the Markers panel: `hidden` lists colors to hide, or `color` with `visible`. View filter only."
        }
        "markers.goNext" => "Moves the playhead to the next marker after it on the sequence (or Source clip).",
        "markers.goPrev" => "Moves the playhead to the previous marker before it on the sequence (or Source clip).",
        "markers.goToIn" => "Moves the playhead to the In point (the start when none is set).",
        "markers.goToOut" => "Moves the playhead to the Out point (the end when none is set).",
        "markers.goToSplitAudioIn" => "Moves the playhead to the split audio In point. Needs a split edit.",
        "markers.goToSplitAudioOut" => "Moves the playhead to the split audio Out point. Needs a split edit.",
        "markers.goToSplitVideoIn" => "Moves the playhead to the split video In point. Needs a split edit.",
        "markers.goToSplitVideoOut" => "Moves the playhead to the split video Out point. Needs a split edit.",
        "markers.markClip" => "Sets In and Out around the clip under the playhead on the first targeted track.",
        "markers.markIn" => {
            "Sets the In point at the playhead or at `time` (ticks), `seconds`, `frame` or `timecode` on the sequence, or on the Source clip with target \"source\" (`time` or `seconds`)."
        }
        "markers.markOut" => {
            "Sets the Out point at the playhead or at `time` (ticks), `seconds`, `frame` or `timecode` on the sequence, or on the Source clip with target \"source\" (`time` or `seconds`)."
        }
        "markers.markSelection" => "Sets In and Out around the selected clips (from the earliest start to the latest end). Needs a clip selection.",
        "markers.markSplitAudioIn" => "Sets a separate audio In point (a split edit, J/L cut) at the playhead or `time`; video keeps its own In.",
        "markers.markSplitAudioOut" => "Sets a separate audio Out point (split edit) at the playhead or `time`.",
        "markers.markSplitVideoIn" => "Sets a separate video In point (split edit) at the playhead or `time`; audio keeps its own In.",
        "markers.markSplitVideoOut" => "Sets a separate video Out point (split edit) at the playhead or `time`.",
        "markers.rippleSequenceMarkers" => "Sets whether ripple edits also move the sequence markers after the edit (`on`, toggles when omitted).",
        "markers.showAllMarkerColors" => "Shows every marker color again in the Markers panel, clearing the color filter.",
        "masks.add" => {
            "Adds a mask to `clip`'s `effect` (default Opacity): `shape` ellipse, polygon or bezier `path`, with `center`, `size` and `path` points in frame (sequence) pixels, mapped onto the clip through its Motion at the playhead so the mask stays on that part of the picture. Answers its index."
        }
        "masks.addVertex" => "Inserts a vertex into a mask path `after` vertex n, at point `at` in frame pixels.",
        "masks.list" => {
            "Lists the masks of `clip` (or every clip with masks) evaluated at the playhead or `time`: effect, index, shape, path points in frame pixels (where the clip's Motion shows them), feather, opacity, mode."
        }
        "masks.moveVertex" => {
            "Moves vertex `vertex` of a mask (or its in/out bezier `handle`) `to` a point or by `delta` in frame pixels; `breakHandles` unlinks the handles."
        }
        "masks.remove" => "Deletes mask `mask` (default selected) from an effect of `clip`.",
        "masks.removeVertex" => "Deletes vertex `vertex` from a mask path.",
        "masks.select" => "Selects mask `mask` of `clip`'s `effect` for editing in the Program monitor, or clears it with `none`.",
        "masks.set" => {
            "Changes a mask: name, inverted, blend `mode`, feather px, opacity %, expansion px, tracking method, or its `path` in frame pixels (keyframed at `time` when animated)."
        }
        "masks.toggleVertexSmooth" => "Converts a mask vertex between a sharp corner and a smooth bezier point.",
        "masks.track" => {
            "Tracks a mask through the clip `direction` forward or backward (for `frames`, default to the end), keyframing its path by position, rotation and scale; `wait` blocks."
        }
        "masks.translate" => "Moves a whole mask by `delta` [dx, dy] frame pixels.",
        "media.attachProxies" => "Attaches existing proxy files (`path` or `paths`) to media `item`/`items`; `force` skips the format check.",
        "media.autoRelink" => "Relinks missing media by remapping a folder prefix (`from` → `to`) or by searching a `folder` tree for the same file names.",
        "media.colorInfo" => "Reads a media `item`'s detected color: primaries, transfer, matrix, range, bit depth and the color space used.",
        "media.createProxies" => {
            "Creates proxy files for the selected or listed `items` with a `preset` (ProRes or H.264, quarter/half size) in `destination`, attaching them by default; `wait` blocks."
        }
        "media.detachProxies" => "Detaches proxies from the selected or listed `items`; the proxy files stay on disk.",
        "media.findMissing" => "Lists project items whose media files are missing, with their last known paths.",
        "media.linkMedia" => "Opens the Link Media dialog for missing files in the host. Agents relink with media.relink or media.autoRelink instead.",
        "media.makeOffline" => "Makes the selected or listed `items` offline (clips show Media Offline); `deleteFiles` also deletes the files on disk.",
        "media.offlineAll" => "Leaves every missing file offline and closes the Link Media dialog.",
        "media.proxyPresets" => "Lists the proxy presets media.createProxies accepts.",
        "media.reconnectFullRes" => "Points media `item`'s full-resolution file at `path` while keeping its proxy.",
        "media.relink" => {
            "Links media `item` to the file at `path` (checked to match unless `force`), then relinks other missing items found the same way when `relinkOthers`."
        }
        "media.replaceFootage" => "Replaces media `item`'s file with the one at `path` without matching checks; clips using it show the new file.",
        "media.search" => "Searches `folder` for files matching missing media (`item` or all) by `exactName`; answers candidates without relinking.",
        "media.status" => "Reads media `item`'s (or every item's) file status: online, offline or missing, proxy attached, path.",
        "media.toggleProxies" => {
            "Switches playback between proxies and full-resolution media (`enabled`, toggles when omitted). Export always uses full resolution."
        }
        "mediaBrowser.clearRecent" => "Clears the Media Browser's recent folders.",
        "mediaBrowser.favorite" => "Adds a folder to, or removes it from, the Media Browser favorites.",
        "mediaBrowser.import" => "Imports the Media Browser's selected files (or `paths`) into the project, applying the project's ingest settings.",
        "mediaBrowser.list" => "Lists the entries of a folder (default the current one) filtered by the Media Browser file types.",
        "mediaBrowser.navigate" => "Goes to a folder in the Media Browser, or `back`, `forward` or `up`.",
        "mediaBrowser.openInSource" => "Opens the Media Browser's selected file (or `path`) in the Source monitor without importing it.",
        "mediaBrowser.probe" => "Reads a file's media properties (frame rate, duration, video and audio streams) at `path`, cached.",
        "mediaBrowser.roots" => "Lists the Media Browser's locations: volumes, favorites and recent folders.",
        "mediaBrowser.select" => "Sets the Media Browser's selected files, which mediaBrowser.import and Import from Media Browser use.",
        "mediaBrowser.settings" => {
            "Sets Media Browser options: shown `fileTypes`, list or thumbnail `view`, columns, import numbered stills as image sequences, hover scrub, thumbnail size."
        }
        "mediaCache.clean" => "Deletes media cache files no longer used by open projects, or `all` of them.",
        "mediaCache.info" => "Reads the media cache: folder, size, and file counts (peaks, conformed audio, previews).",
        "metadata.get" => "Reads the metadata fields of project `item` or timeline `clip`'s source (Name, Label, Description, Scene, Shot, Log Note…).",
        "metadata.set" => {
            "Sets metadata `field` to `value` (or several `fields`) on project `item` or `clip`'s source; one undo step. Name renames the item and Label sets its color label."
        }
        "mixer.addInsert" => "Adds a track effect `effect` to a mixer `strip` (A1…, S1…, Mix) at `slot` (default last), pre-fader unless `postFader`.",
        "mixer.addSend" => {
            "Adds a send from an audio track or submix `strip` to submix `target` at `levelDb`, post-fader unless `preFader`, with `pan`. The Mix has no sends."
        }
        "mixer.addSubmix" => {
            "Adds an audio submix track with `name` and `channels` Mono|Stereo|5.1 (default Stereo). Route tracks to it with mixer.setStrip `output` or mixer.addSend."
        }
        "mixer.clearLane" => "Deletes every automation keyframe of `lane` (default volume) on a mixer `strip`.",
        "mixer.deleteKeyframe" => "Deletes the automation keyframe at `time` ticks on a strip's `lane` (default volume).",
        "mixer.deleteSubmix" => "Removes submix track `strip` (S1…); tracks and sends that fed it route to the Mix.",
        "mixer.inspect" => {
            "Reads the Audio Track Mixer at `time` (default playhead): every strip's volume, pan, mute/solo, mode, output, sends, track effects and automation values."
        }
        "mixer.moveKeyframe" => "Moves the automation keyframe at `time` on a strip's `lane` to `newTime` and/or changes its `value`.",
        "mixer.recordStart" => {
            "Starts an automation pass at `time` (default playhead); mixer.touch/release gestures are recorded per each strip's mode until mixer.recordStop."
        }
        "mixer.recordStop" => {
            "Ends the automation pass at `time`, thins every recorded gesture into keyframes and writes them as one undo step (Write strips may switch to Touch)."
        }
        "mixer.release" => {
            "Lets go of a mixer control (`lane`, default volume) on `strip` at `time`; in Touch mode the value ramps back to the existing automation."
        }
        "mixer.removeInsert" => "Removes the track effect at `slot` (0-based) from a mixer `strip`.",
        "mixer.removeSend" => "Removes send number `send` (0-based) from a mixer `strip`.",
        "mixer.setInsert" => "Changes the track effect at `slot` on a `strip`: `enabled`, pre/post fader, or effect `params` by id.",
        "mixer.setKeyframe" => {
            "Adds or replaces an automation keyframe of `value` at `time` (default playhead) on a strip's `lane` (volume dB, pan -1…1, mute, send.i.level, fx.slot.param)."
        }
        "mixer.setSend" => "Changes send `send` (0-based) on a `strip`: level dB, pan, pre/post fader, mute, or retarget to another submix.",
        "mixer.setStrip" => {
            "Changes a mixer strip's static settings: name, volume dB, pan, mute, solo, record arm, solo safe, automation mode, output routing, input map, channels."
        }
        "mixer.setValue" => {
            "Sets a mixer control (`lane`) on `strip` to `value` once: writes a keyframe at `time` when the lane has automation, else the static value. Use mixer.touch for recorded gestures."
        }
        "mixer.touch" => {
            "Moves a mixer control during an automation pass: the audio follows at once and the value is recorded at `time` per the strip's automation mode."
        }
        "mixer.writeAutomation" => {
            "Writes a whole automation curve to a strip's `lane` from `points` [[ticks, value]…], thinned to keyframes within `tolerance`, replacing that span; one undo step."
        }
        "multicam.audioFollowsVideo" => {
            "Sets whether switching a multi-camera clip's video angle also switches its linked audio clips (`enabled`, toggles when omitted)."
        }
        "multicam.autoAdjustQuality" => {
            "Sets whether the multi-camera grid decodes at lower resolution while playing (`enabled`, toggles when omitted). View setting only."
        }
        "multicam.cut" => {
            "While multi-camera recording, cuts to `camera` (1–16, shown order) or `angle` (0-based) at `time` (default playhead); `videoOnly` leaves audio. Use multicam.switchAngle when not recording."
        }
        "multicam.cutToCamera" => {
            "Adds an edit at the playhead on the multi-camera clip (and its linked audio when audio follows video) and shows `camera` from there to the clip's end; `videoOnly` leaves the audio angle."
        }
        "multicam.cutToCamera1" => {
            "Adds an edit at the playhead on the multi-camera clip and shows camera 1 (on the shown grid page) from there to the clip's end; linked audio follows when audio follows video."
        }
        "multicam.cutToCamera2" => {
            "Adds an edit at the playhead on the multi-camera clip and shows camera 2 (on the shown grid page) from there to the clip's end; linked audio follows when audio follows video."
        }
        "multicam.cutToCamera3" => {
            "Adds an edit at the playhead on the multi-camera clip and shows camera 3 (on the shown grid page) from there to the clip's end; linked audio follows when audio follows video."
        }
        "multicam.cutToCamera4" => {
            "Adds an edit at the playhead on the multi-camera clip and shows camera 4 (on the shown grid page) from there to the clip's end; linked audio follows when audio follows video."
        }
        "multicam.cutToCamera5" => {
            "Adds an edit at the playhead on the multi-camera clip and shows camera 5 (on the shown grid page) from there to the clip's end; linked audio follows when audio follows video."
        }
        "multicam.cutToCamera6" => {
            "Adds an edit at the playhead on the multi-camera clip and shows camera 6 (on the shown grid page) from there to the clip's end; linked audio follows when audio follows video."
        }
        "multicam.cutToCamera7" => {
            "Adds an edit at the playhead on the multi-camera clip and shows camera 7 (on the shown grid page) from there to the clip's end; linked audio follows when audio follows video."
        }
        "multicam.cutToCamera8" => {
            "Adds an edit at the playhead on the multi-camera clip and shows camera 8 (on the shown grid page) from there to the clip's end; linked audio follows when audio follows video."
        }
        "multicam.cutToCamera9" => {
            "Adds an edit at the playhead on the multi-camera clip and shows camera 9 (on the shown grid page) from there to the clip's end; linked audio follows when audio follows video."
        }
        "multicam.editCameras" => {
            "Renames, shows or hides cameras (`cameras` by 0-based `angle`) of a multi-camera source `sequence`, and sets its `audio` mode: camera1, all or switch."
        }
        "multicam.grid" => {
            "Reads the multi-camera grid page at the playhead (or `time`): layout, pages and cells with camera, angle, name and which is active; `cellPixels` picks a decode size."
        }
        "multicam.gridLayout" => "Sets the multi-camera angle grid layout: auto, 2x2, 3x3 or 4x4 (paged when the angles don't fit).",
        "multicam.inspect" => {
            "Reads the multi-camera clip at the playhead (or `time`): its source, cameras with names and angles, the active angle and the recorder state."
        }
        "multicam.nextPage" => "Shows the next page of the multi-camera angle grid; number keys pick cameras on the shown page.",
        "multicam.page" => "Shows `page` (0-based, or next/prev) of the multi-camera angle grid.",
        "multicam.prevPage" => "Shows the previous page of the multi-camera angle grid.",
        "multicam.recordStart" => {
            "Starts a multi-camera recording pass at `time` (default playhead): cuts made with multicam.cut until multicam.recordStop become one undo step."
        }
        "multicam.recordStop" => "Ends the multi-camera recording pass at `time` and commits its cuts to the multi-camera clip as one undo step.",
        "multicam.selectCamera1" => {
            "While multi-camera recording, cuts to camera 1 at the playhead; when stopped, switches the multi-camera clip at the playhead to camera 1 without adding an edit."
        }
        "multicam.selectCamera2" => {
            "While multi-camera recording, cuts to camera 2 at the playhead; when stopped, switches the multi-camera clip at the playhead to camera 2 without adding an edit."
        }
        "multicam.selectCamera3" => {
            "While multi-camera recording, cuts to camera 3 at the playhead; when stopped, switches the multi-camera clip at the playhead to camera 3 without adding an edit."
        }
        "multicam.selectCamera4" => {
            "While multi-camera recording, cuts to camera 4 at the playhead; when stopped, switches the multi-camera clip at the playhead to camera 4 without adding an edit."
        }
        "multicam.selectCamera5" => {
            "While multi-camera recording, cuts to camera 5 at the playhead; when stopped, switches the multi-camera clip at the playhead to camera 5 without adding an edit."
        }
        "multicam.selectCamera6" => {
            "While multi-camera recording, cuts to camera 6 at the playhead; when stopped, switches the multi-camera clip at the playhead to camera 6 without adding an edit."
        }
        "multicam.selectCamera7" => {
            "While multi-camera recording, cuts to camera 7 at the playhead; when stopped, switches the multi-camera clip at the playhead to camera 7 without adding an edit."
        }
        "multicam.selectCamera8" => {
            "While multi-camera recording, cuts to camera 8 at the playhead; when stopped, switches the multi-camera clip at the playhead to camera 8 without adding an edit."
        }
        "multicam.selectCamera9" => {
            "While multi-camera recording, cuts to camera 9 at the playhead; when stopped, switches the multi-camera clip at the playhead to camera 9 without adding an edit."
        }
        "multicam.selectionTopDown" => {
            "Sets whether stacked multi-camera clips switch the topmost clip instead of the lowest (`enabled`, toggles when omitted)."
        }
        "multicam.showPreviewMonitor" => {
            "Sets whether the program shows next to the multi-camera grid (`enabled`); off, the grid fills the monitor. View setting only."
        }
        "multicam.switchAngle" => {
            "Sets the active angle of the multi-camera clips at `time` (or `clips`) to `camera` (1–16, shown order) or `angle` (0-based) for their whole length; `videoOnly`/`audioOnly` limit it. No edit is added."
        }
        "multicam.transmitView" => "Sets whether the multi-camera grid is sent to the transmit device; stored only, there is no transmit output yet.",
        "perf.stats" => "Reads performance statistics: decode, render and cache timings and memory.",
        "playhead.end" => "Moves the playhead to the end of the active sequence.",
        "playhead.nextEdit" => {
            "Moves the playhead to the next edit point on the targeted tracks (all tracks when none is targeted). Use playhead.nextEditAnyTrack to ignore targeting."
        }
        "playhead.nextEditAnyTrack" => "Moves the playhead to the next edit point on any track, regardless of track targeting.",
        "playhead.prevEdit" => "Moves the playhead to the previous edit point on the targeted tracks (all tracks when none is targeted).",
        "playhead.prevEditAnyTrack" => "Moves the playhead to the previous edit point on any track, regardless of track targeting.",
        "playhead.selectedClipEnd" => {
            "Moves the playhead to the last frame of the selected clips (the frame before their out edge). Needs a clip selection. Answers {time}."
        }
        "playhead.selectedClipStart" => "Moves the playhead to the first frame of the selected clips. Needs a clip selection. Answers {time}.",
        "playhead.set" => {
            "Moves the sequence playhead to `time` (ticks, 254016000000 per second), `frame` (0-based sequence frame), `seconds` or `timecode`. Answers {time} in ticks."
        }
        "playhead.start" => "Moves the playhead to the start of the active sequence (time 0).",
        "playhead.step" => "Moves the playhead by `frames` sequence frames (negative steps back, stops at 0). Answers {frame}.",
        "playhead.stepBack" => "Moves the playhead one frame earlier.",
        "playhead.stepBack5" => "Moves the playhead back by the Step Many Frames preference (5 by default).",
        "playhead.stepForward" => "Moves the playhead one frame later.",
        "playhead.stepForward5" => "Moves the playhead forward by the Step Many Frames preference (5 by default).",
        "prefs.get" => "Reads preferences: one `key` (e.g. audio.scrubAudio, trim.largeTrimOffset) or all.",
        "prefs.reset" => "Resets preferences to defaults: one `category` or all.",
        "prefs.schema" => "Lists every preference key with its type, default, allowed values and category.",
        "prefs.set" => "Sets preference `key` to `value`, or several `values`; see prefs.schema for keys and types.",
        "presets.apply" => "Applies effect `preset` to the selected or listed `clips`.",
        "presets.delete" => "Deletes saved effect preset `name`; clips it was applied to keep their effects.",
        "presets.export" => "Writes effect presets (`names`, default all) to a preset file at `path`.",
        "presets.import" => "Reads effect presets from the file at `path` into the preset library.",
        "presets.list" => "Lists saved effect presets with their effects and keyframe handling.",
        "presets.rename" => "Renames effect preset `name` to `to`.",
        "presets.save" => {
            "Saves `clip`'s effects (`effects` indices, default all) as preset `name`; `keyframes` scale|anchorIn|anchorOut|none decides how keyframes fit other clips."
        }
        "project.columns.list" => {
            "Lists every Project panel column (built-ins plus metadata fields found on items) and whether each is shown, in display order with widths."
        }
        "project.columns.resize" => "Sets the width of one Project panel `column` to `width` pixels. View setting only.",
        "project.columns.set" => "Sets which Project panel columns show and in what order: `columns` is a list of names or {name, width}.",
        "project.delete" => {
            "Deletes the listed or selected project `items` (bins with their contents); clips using them are removed from sequences. Answers what was removed."
        }
        "project.deleteSearchBin" => "Deletes search bin `bin`; the items it matched stay in the project.",
        "project.deselectAll" => "Clears the Project panel selection.",
        "project.editSearchBin" => {
            "Changes search bin `bin`: its name and the query (`column`, `operator`, `text`, or `rows` with `matchAll`, `caseSensitive`)."
        }
        "project.freeform.alignToGrid" => "Snaps the clip cards of `bin` (default root) in Freeform view to a `grid` of the given spacing; undoable.",
        "project.freeform.arrangements" => "Lists the saved Freeform arrangements of `bin` (default root).",
        "project.freeform.deleteArrangement" => "Deletes the saved Freeform arrangement `name` of `bin`.",
        "project.freeform.layout" => "Reads the Freeform card positions and sizes of `bin`'s items (auto-placed ones included) for a panel `width`.",
        "project.freeform.move" => {
            "Moves Freeform clip cards: the listed or selected `items` to (`x`, `y`), or per-item positions; `snap` aligns to the grid. Undoable."
        }
        "project.freeform.options" => "Sets Freeform view options: grid spacing, snapping, showing names and durations, card size.",
        "project.freeform.reset" => "Resets `bin`'s Freeform cards to the default grid layout, dropping manual positions.",
        "project.freeform.resize" => "Sets the card size of the listed or selected `items` in Freeform view.",
        "project.freeform.restoreArrangement" => "Restores the saved Freeform arrangement `name` of `bin`, moving the cards back.",
        "project.freeform.saveArrangement" => "Saves the current Freeform card positions of `bin` as arrangement `name`.",
        "project.freeform.stack" => "Groups the listed or selected `items` into one stack in Freeform view.",
        "project.freeform.unstack" => "Splits the stack holding the listed or selected `items` back into separate cards.",
        "project.ingestSettings" => {
            "Reads or sets the project's ingest settings: `enabled`, `action` copy|transcode|createProxies|copyAndCreateProxies, `destination` folder and transcode `preset`."
        }
        "project.inspect" => {
            "Reads the whole project: bins and items with ids, kinds (media, sequence, generators), durations, frame rates and media paths. Read first to find item ids."
        }
        "project.items" => "Lists the rows the Project panel shows for `bin` (default root; `recursive` for sub-bins), sorted, with each shown column's text.",
        "project.matteColor" => {
            "Changes a Color Matte item's color (`item` or the Project panel selection) to `color` #rrggbb; every clip of the matte follows."
        }
        "project.moveToBin" => "Moves the listed or selected project `items` into `bin` (null for the root). Answers how many moved.",
        "project.renameBin" => "Renames bin `bin` to `name`.",
        "project.searchBinItems" => "Lists the items search bin `bin` currently matches.",
        "project.searchBins" => "Lists the project's search bins with their queries and live contents.",
        "project.select" => "Sets the Project panel selection to `items`; many project commands act on this selection.",
        "project.selectAll" => "Selects every item in the project. Answers {selected}.",
        "project.setMarks" => {
            "Sets or clears (null) the source In and Out points of project `item` (default the Source monitor item), in ticks of the item's time."
        }
        "project.sort" => "Sorts the Project panel List view by `column` (`descending` reverses). View setting only.",
        "project.view.get" => {
            "Reads the Project panel view: list/icon/freeform, icon and font size, preview area, thumbnails, the shown columns and every available column."
        }
        "project.view.set" => "Sets the Project panel view: `view` list|icon|freeform, icon size, font size, preview area, thumbnails and hover scrub.",
        "project.viewPreset.delete" => "Deletes the Project panel view preset in `slot` (1–10).",
        "project.viewPreset.list" => "Lists the saved Project panel view presets (slots 1–10) and the current one.",
        "project.viewPreset.rename" => "Renames the Project panel view preset in `slot` to `name`.",
        "project.viewPreset.restore" => "Applies the Project panel view preset in `slot` (1–10).",
        "project.viewPreset.save" => "Saves the current Project panel view over the current preset (or `slot`) with `name`.",
        "project.viewPreset.saveAs" => "Saves the current Project panel view as a new preset in `slot` (default the first free) named `name`.",
        "scopes.read" => {
            "Measures the program frame at the playhead or `time` with scopes (waveform, parade, histogram, vectorscopes), summarised in `columns`, `peaks` and bins."
        }
        "sequence.addEdit" => {
            "Cuts clips at the playhead or at `time` (ticks), `seconds`, `frame` or `timecode`: the selected clips under it if any, otherwise every clip on the targeted tracks. Use sequence.addEditAllTracks to cut all tracks."
        }
        "sequence.addEditAllTracks" => {
            "Cuts every clip on all unlocked tracks (and caption tracks) at the playhead or at `time` (ticks), `seconds`, `frame` or `timecode`."
        }
        "sequence.addTracks" => {
            "Adds `video`, `audio` and `submix` tracks, each after a given track (`videoAfter` \"first\", \"V2\" or an index), with `audioType` and `submixType` channel layouts."
        }
        "sequence.applyAudioTransition" => {
            "Applies an audio transition (`effect`, default the default audio transition, `frames` long) at the edit nearest the playhead on targeted tracks, or at `clip`'s `edge`; between two clips `align` puts it centred on the cut (default), starting or ending there. Its length is kept inside the clips it joins."
        }
        "sequence.applyVideoTransition" => {
            "Applies a video transition (`effect` e.g. cross_dissolve, `frames` long, default from preferences) at the edit nearest the playhead on targeted tracks, or at `clip`'s `edge`; between two clips `align` puts it centred on the cut (default), starting or ending there; `params` and `reverse` set it up. Its length is kept inside the clips it joins."
        }
        "sequence.close" => "Closes the timeline tab of sequence `item` (default the active one); the sequence stays in the project.",
        "sequence.closeGap" => "Closes the gap on `track` at `time` (default playhead) by moving the clips after it earlier (ripple delete of the gap).",
        "sequence.closeOthers" => "Closes every open timeline tab except sequence `item` (default the active one).",
        "sequence.colorSettings" => {
            "Sets the active sequence's color management: `workingSpace` rec709, rec2100-pq or rec2100-hlg, `wideGamut`, `autoToneMap`."
        }
        "sequence.deleteRenderFiles" => "Deletes all preview render files of the active sequence (it shows unrendered again).",
        "sequence.deleteRenderFilesInToOut" => "Deletes the preview render files between the sequence In and Out points.",
        "sequence.deleteTrack" => "Deletes `track` (V3, A2 or an id) and every clip on it.",
        "sequence.deleteTracks" => "Deletes all empty video and/or audio tracks (`video`/`audio`: \"empty\") or one named track of each kind.",
        "sequence.extract" => {
            "Removes the In–Out range on targeted tracks and closes the gap (later clips move earlier; ripple sequence markers when on). Needs In and Out. Use sequence.lift to leave a gap."
        }
        "sequence.goToNextGap" => "Moves the playhead to the start of the next gap across the whole sequence.",
        "sequence.goToNextGapInTrack" => "Moves the playhead to the start of the next gap on `track` (default the first targeted track).",
        "sequence.goToPrevGap" => "Moves the playhead to the start of the previous gap across the whole sequence.",
        "sequence.goToPrevGapInTrack" => "Moves the playhead to the start of the previous gap on `track` (default the first targeted track).",
        "sequence.inspect" => {
            "Reads sequence `item` (default active): settings, tracks with their clips (ids, times in ticks, sources, effects), transitions, markers, In/Out and playhead. The main read before editing a timeline."
        }
        "sequence.joinThroughEdits" => {
            "Removes through edits (cuts where the media continues uninterrupted) at the selected `clips`, or everywhere with `all`, rejoining the pieces."
        }
        "sequence.lift" => {
            "Removes the In–Out range on targeted tracks and leaves a gap; nothing moves. Needs In and Out. Use sequence.extract to close the gap."
        }
        "sequence.linkedSelection" => "Sets whether selecting a clip also selects its linked video/audio partners (`on`, toggles when omitted).",
        "sequence.makeSubsequence" => {
            "Creates a new sequence named `name` from the clips between In and Out (or the selected clips) on targeted tracks; the original is unchanged."
        }
        "sequence.matchFrame" => "Opens the source of the topmost clip under the playhead in the Source monitor at the matching source frame.",
        "sequence.moveTab" => "Moves the timeline tab of sequence `item` to position `index` (0-based) among the open tabs.",
        "sequence.nestSequences" => "Sets whether sequences placed into a timeline go in as one nested clip (`on`) or as their individual clips.",
        "sequence.normalizeMixTrack" => "Sets the Mix track fader so the whole mix peaks at `db` (default 0 dBFS).",
        "sequence.open" => "Opens sequence `item` in a timeline tab and makes it the active sequence that other commands act on.",
        "sequence.renderAudio" => "Renders audio previews (float WAV) for In–Out or the whole sequence; `wait` blocks until done.",
        "sequence.renderBar" => "Reads the active sequence's render bar: the spans that are rendered, need rendering or play in real time.",
        "sequence.renderEffectsInToOut" => "Renders previews only for the segments with unrendered effects between In and Out; `wait` blocks until done.",
        "sequence.renderInToOut" => "Renders previews for every segment between In and Out; `wait` blocks until done.",
        "sequence.renderSelection" => "Renders previews for the time spanned by the selected clips; `wait` blocks until done.",
        "sequence.revealInProject" => "Selects and shows sequence `item` (default the active one) in the Project panel.",
        "sequence.revealNested" => "Opens the nested sequence of the selected (or topmost targeted) nested clip with its playhead on the matching frame.",
        "sequence.reverseMatchFrame" => "Finds the Source monitor's current frame in the active sequence (targeted tracks first) and moves the playhead there.",
        "sequence.selectionFollowsPlayhead" => {
            "Sets whether the clips under the playhead on targeted tracks are selected automatically as it moves (`on`, toggles when omitted)."
        }
        "sequence.setTransition" => {
            "Changes an applied `transition` by id: effect `params`, `reverse`, `reset` to defaults, and where it sits: `duration` (ticks) or `frames` resizes it as its alignment says, `align` (center, start, end) puts it on its cut, `start` (ticks) moves it, with `duration` one end. It stays over its cut and inside the clips it joins. `merge` makes a drag's calls one undo step (`begin` starts a new one). Answers its `start`, `duration` and `align`."
        }
        "sequence.removeTransition" => "Removes the applied `transitions` (ids) in one undo step; the clips stay.",
        "sequence.settings" => {
            "Changes the active sequence's settings: frame size, `fps`, name, sample rate, audio mix layout, drop-frame timecode, render quality and color working space; a new frame size or rate renames the preset (`WxH fps`)."
        }
        "sequence.showThroughEdits" => "Sets whether through edits are marked in the timeline (`on`, toggles when omitted). View setting only.",
        "sequence.simplify" => {
            "Creates a simplified copy named `name` of the active sequence: removes disabled clips, empty tracks, effects or text and can close gaps or move clips down; `keep` both, video or audio."
        }
        "sequence.snap" => "Sets whether timeline drags snap to edits, markers and the playhead (`on`, toggles when omitted).",
        "sequence.throughEdits" => "Lists the through edits of the active sequence: {track, left, right, time ticks} for each cut where the media continues.",
        "sequence.transcribe" => {
            "Transcribes the active sequence's audio (`track`: mix or an audio track) into a transcript, in `language` (auto detects), with speaker labels when `diarize`."
        }
        "shortcuts.audit" => "Checks the shortcut table for unknown commands, conflicts and invalid keys.",
        "shortcuts.clear" => "Removes `keys` (or every shortcut) from `command` in `panel`.",
        "shortcuts.conflicts" => "Lists keys assigned to more than one command in the same panel on `platform`.",
        "shortcuts.deletePreset" => "Deletes saved keyboard shortcut preset `name`.",
        "shortcuts.export" => "Writes the current keyboard shortcuts to a file at `path`.",
        "shortcuts.forKey" => "Lists the commands on `key` with every modifier combination.",
        "shortcuts.get" => "Reads the shortcuts assigned to `command` on `platform`.",
        "shortcuts.import" => "Reads a keyboard shortcut file at `path` as a preset and makes it active unless `activate: false`.",
        "shortcuts.list" => "Lists keyboard shortcuts, filtered by `query`, `panel`, `assigned` and `platform`.",
        "shortcuts.loadPreset" => "Switches to keyboard shortcut preset `name`.",
        "shortcuts.presets" => "Lists the keyboard shortcut presets (built-in and saved) and the current one.",
        "shortcuts.redo" => "Redoes the last undone keyboard shortcut change.",
        "shortcuts.registerExternal" => "Registers host-side (frontend) commands so they can be given keyboard shortcuts; host use only.",
        "shortcuts.resolve" => "Answers which command `keys` would run in `panel` on `platform`.",
        "shortcuts.savePreset" => "Saves the current shortcuts as preset `name`.",
        "shortcuts.set" => {
            "Assigns `keys` (e.g. Cmd+Shift+K) to `command` in `panel`; `add` keeps its existing keys, and conflicting assignments are removed unless `keepConflicts`."
        }
        "shortcuts.undo" => "Undoes the last keyboard shortcut change.",
        "sound.phrase" => {
            "Builds a stock sound phrase at `frame` (or `seconds`) from sound items the caller imported, as one undo step, each sound peak-aligned (its loudest sample on the frame) on the first free audio track: `closing` = items.riser starting at the frame (0.5), items.impact peaking `impactAfterFrames` (35) later at 0.55 (keep it the loudest sound, at most three such hits a film), items.sparkle `sparkleAfterFrames` (25) after the impact at 0.3; `titleIn` = items.swoosh 0.4; `sceneIn` = items.transition 0.4; `click` = items.click 0.6; `hitRun` = `count` (6) hits alternating items.hit / items.hitAlt, volume stepping 0.40 → 0.25, spacing from `spacingFrames` (5) to `endSpacingFrames`; hits closer than 3 frames blur, so items.swoosh plays once over the run instead. `gainOffsetDb` shifts every gain. Answers `placed` as timeline.placeMany."
        }
        "source.insert" => {
            "Three-point edit: inserts the Source monitor's In–Out range at the sequence In point (else the playhead) on the source-patched tracks, pushing later clips right. Use source.overwrite to replace instead."
        }
        "source.inspect" => {
            "Reads the Source monitor: the open item, its In/Out, source playhead, frame size and streams. Answers {item:null} when nothing is open."
        }
        "source.open" => "Opens a project `item` (default: the Project panel selection) in the Source monitor; a subclip opens at its In point.",
        "source.overwrite" => {
            "Three-point edit: places the Source monitor's In–Out range at the sequence In point (else the playhead) on the source-patched tracks, replacing what is there; nothing moves."
        }
        "source.setPlayhead" => {
            "Moves the Source monitor playhead to `time` ticks, `frame` (source frame) or `seconds`. Needs a clip open in the Source monitor."
        }
        "state.inspect" => {
            "Reads the editor state: active sequence, playhead, selections (clips, captions, project items, edit points), targeting, In/Out and toggles like snapping and linked selection."
        }
        "timeline.move" => {
            "Moves clips to new tracks and times in one step: `moves` lists {clip, track, time ticks}. `insert: true` pushes clips at the destination right; otherwise it overwrites. Linked partners follow unless `linked: false`. `copy: true` copies the clips there instead and leaves them where they are (the answer's `copied` names the copies). `snap` (\"markers\", \"beats\" or both) lands the earliest clip on the nearest sequence marker or music beat within `toleranceFrames` (3) and moves the rest by as much; the answer's `snapped` says {from, to}."
        }
        "timeline.moveAudioTargetsDown" => "Moves every audio track target down by one track.",
        "timeline.moveAudioTargetsUp" => "Moves every audio track target up by one track.",
        "timeline.moveVideoTargetsDown" => "Moves every video track target down by one track.",
        "timeline.moveVideoTargetsUp" => "Moves every video track target up by one track.",
        "timeline.nudgeDown" => {
            "Moves the selected clips (with linked partners) one track down as displayed (video to V(n-1), audio to A(n+1)), overwriting there."
        }
        "timeline.nudgeLeft" => "Moves the selected clips (with linked partners) one frame earlier, overwriting what they land on.",
        "timeline.nudgeLeft5" => "Moves the selected clips (with linked partners) five frames earlier, overwriting what they land on.",
        "timeline.nudgeRight" => "Moves the selected clips (with linked partners) one frame later, overwriting what they land on.",
        "timeline.nudgeRight5" => "Moves the selected clips (with linked partners) five frames later, overwriting what they land on.",
        "timeline.nudgeUp" => {
            "Moves the selected clips (with linked partners) one track up as displayed (video to V(n+1), audio to A(n-1)), overwriting there."
        }
        "timeline.place" => {
            "Places project `item` on the timeline at `time` (ticks), `frame` or `seconds` on `track` (and `audioTrack`), from `sourceIn` for `duration`; `insert: true` pushes later clips right, false overwrites. `video`/`audio` choose streams. `track: \"auto\"` / `audioTrack: \"auto\"` put the picture / sound on the first track with room for it (a new track when none has) instead of overwriting, and answer the track chosen (\"V2\", \"A3\"). `snap` (\"markers\", \"beats\" or both) starts the clip on the nearest sequence marker or music beat within `toleranceFrames` (3). Answers the new clip ids (and `snapped`)."
        }
        "timeline.placeMany" => {
            "Places several sounds as one undo step: each of `items` ({item, frame | seconds, gainDb or volume, fadeInFrames/fadeInSeconds, fadeOutFrames/fadeOutSeconds, durationFrames/durationSeconds}) goes on the first audio track with no clip in its span (a new track below the others when none has room), so sounds never overwrite each other. `alignPeak: true` starts the clip at frame − the sound's peak lag (its loudest sample, from the decoded audio), so a whoosh's or impact's hit lands on the frame; a head before 0 is dropped. Fades are Constant Gain audio transitions on the clip's edges. Answers `placed`: [{clips, audioTrack (\"A3\"), frame (clip start), peakFrame, peakLagFrames, gainDb}]."
        }
        "timeline.rateStretch" => {
            "Drags `clip`'s in or out `edge` by `delta` ticks and changes its speed so the same media fills the new length (Rate Stretch tool). Answers the new speed."
        }
        "timeline.razor" => {
            "Cuts clips at `time` (ticks), `seconds`, `frame` or `timecode` (default playhead): only `clip` (and linked partners) when given, else every clip on `track`, else all unlocked tracks. Answers `cuts`, the new clip ids (`clips`: the right-hand piece of each cut; the cut clip keeps its id for the left piece), and `pieces` ({left, right} for each cut)."
        }
        "timeline.roll" => {
            "Rolling edit between adjacent clips `left` and `right`: moves the cut by `delta` ticks or `deltaFrames`, lengthening one and shortening the other; total duration is unchanged."
        }
        "timeline.select" => {
            "Sets the timeline clip selection to `clips`; `add` adds to it, `toggle` flips each clip; linked partners are included unless `linked: false`."
        }
        "timeline.selectClipAtPlayhead" => "Selects the clips under the playhead on the targeted tracks.",
        "timeline.selectNextClip" => {
            "Selects the clip after each selected clip on its track; with nothing selected, the clips at the playhead on targeted tracks."
        }
        "timeline.selectPrevClip" => {
            "Selects the clip before each selected clip on its track; with nothing selected, the clips at the playhead on targeted tracks."
        }
        "timeline.setTargeting" => {
            "Turns track targeting (`targeted`, used by paste, match frame and edit navigation) and/or source patching (`sourcePatch`, where source.insert/overwrite land) on or off for `track`."
        }
        "timeline.setTrack" => "Changes a track's settings: locked, sync lock, enabled (output), muted, solo, name, and for audio volume dB and pan.",
        "timeline.slide" => {
            "Slide edit: moves `clip` by `delta` ticks or `deltaFrames` while trimming its neighbours to keep the gap closed; the clip's content and the sequence length don't change."
        }
        "timeline.slideLeft" => "Slides the selected clips one frame earlier, trimming their neighbours (Slide tool).",
        "timeline.slideLeft5" => "Slides the selected clips five frames earlier, trimming their neighbours.",
        "timeline.slideRight" => "Slides the selected clips one frame later, trimming their neighbours.",
        "timeline.slideRight5" => "Slides the selected clips five frames later, trimming their neighbours.",
        "timeline.slip" => {
            "Slip edit: shifts which part of the source `clip` shows by `delta` ticks or `deltaFrames`, keeping its position and length on the timeline."
        }
        "timeline.slipLeft" => "Slips the selected clips' content one frame (shows later source frames) without moving them.",
        "timeline.slipLeft5" => "Slips the selected clips' content five frames (later source frames) without moving them.",
        "timeline.slipRight" => "Slips the selected clips' content one frame back (earlier source frames) without moving them.",
        "timeline.slipRight5" => "Slips the selected clips' content five frames back (earlier source frames) without moving them.",
        "timeline.toggleAllAudioTargets" => "Targets all audio tracks, or untargets them all if they already are.",
        "timeline.toggleAllSourceAudio" => "Turns source patching on for all audio tracks, or off if it already is.",
        "timeline.toggleAllSourceVideo" => "Turns source patching on for all video tracks, or off if it already is.",
        "timeline.toggleAllVideoTargets" => "Targets all video tracks, or untargets them all if they already are.",
        "timeline.toggleMuteTargetedAudio" => "Toggles mute on every targeted audio track.",
        "timeline.toggleOutputTargetedVideo" => "Toggles track output (visibility) of every targeted video track.",
        "timeline.toggleSoloTargetedAudio" => "Toggles solo on every targeted audio track.",
        "timeline.toggleTargetA1" => "Toggles track targeting of audio track A1.",
        "timeline.toggleTargetA2" => "Toggles track targeting of audio track A2.",
        "timeline.toggleTargetA3" => "Toggles track targeting of audio track A3.",
        "timeline.toggleTargetA4" => "Toggles track targeting of audio track A4.",
        "timeline.toggleTargetA5" => "Toggles track targeting of audio track A5.",
        "timeline.toggleTargetA6" => "Toggles track targeting of audio track A6.",
        "timeline.toggleTargetA7" => "Toggles track targeting of audio track A7.",
        "timeline.toggleTargetA8" => "Toggles track targeting of audio track A8.",
        "timeline.toggleTargetV1" => "Toggles track targeting of video track V1.",
        "timeline.toggleTargetV2" => "Toggles track targeting of video track V2.",
        "timeline.toggleTargetV3" => "Toggles track targeting of video track V3.",
        "timeline.toggleTargetV4" => "Toggles track targeting of video track V4.",
        "timeline.toggleTargetV5" => "Toggles track targeting of video track V5.",
        "timeline.toggleTargetV6" => "Toggles track targeting of video track V6.",
        "timeline.toggleTargetV7" => "Toggles track targeting of video track V7.",
        "timeline.toggleTargetV8" => "Toggles track targeting of video track V8.",
        "timeline.trim" => {
            "Trims `clip`'s in or out `edge` by `delta` ticks or `deltaFrames`: `mode` regular leaves a gap or overlaps; ripple moves later clips to keep the edit closed. `snap` (\"markers\", \"beats\" or both) lands the trimmed edge on the nearest sequence marker or music beat within `toleranceFrames` (3)."
        }
        "transcript.createCaptions" => {
            "Creates a caption track from the sequence transcript: `maxChars` per line, 1 or 2 `lines`, caption length between `minSeconds` and `maxSeconds`, `gapFrames` between captions."
        }
        "transcript.delete" => "Deletes the transcripts of the selected or listed `items`.",
        "transcript.downloadModel" => "Downloads speech `model` (default whisper-base) for transcript.generate.",
        "transcript.extract" => "Removes the sequence span of transcript words `from`–`to` and closes the gap (text-based ripple delete).",
        "transcript.generate" => {
            "Transcribes the speech of the selected or listed `items` with a local speech `model` in `language` (auto detects), with speaker labels when `diarize`."
        }
        "transcript.inspect" => {
            "Reads the active sequence's transcript as paragraphs of words with sequence times and speakers; `paragraphGapSeconds` sets where paragraphs break."
        }
        "transcript.lift" => "Removes the sequence span of transcript words `from`–`to` and leaves a gap.",
        "transcript.models" => "Lists the local speech models and whether each is downloaded.",
        "transcript.removeFillers" => "Extracts filler words (`fillers`, default um, uh…) from the sequence by ripple delete.",
        "transcript.removePauses" => "Extracts pauses longer than `minSeconds` from the sequence, keeping `keepSeconds` of each, by ripple delete.",
        "transcript.renameSpeaker" => "Renames a transcript speaker (\"Speaker 1\" or index) to `name`, in `item`'s transcript or all.",
        "transcript.search" => "Finds `query` in the active sequence's transcript and answers the matching words with their sequence times.",
        "transcript.select" => "Sets In and Out around transcript words `from`–`to` (word indices from transcript.inspect).",
        "transcript.set" => "Stores a transcript for `item` from the given words (text, start/end ticks, speaker) instead of transcribing.",
        "transition.beatCut" => {
            "Cuts picture on the beat as one undo step: puts a video transition centred on every cut between two clips that lies within `toleranceFrames` (1) of a beat of the sequence's music (or of a sequence marker when no audio clip has a beat; `onBeat: false` takes every cut), or only on the cuts into `clips`, or at the `at` frames (taken as given). `effect` is whip, flash, push, crossZoom, cut (no transition, sound only) or any video transition id, or a list used in turn; `frames` sets the length (whip 8, flash 6, push 10, crossZoom 10); `params` are transition parameters, each effect taking the ones it has (booleans for amounts such as motion_blur, left/right/up/down for direction). `sfx` (a sound item or a list used in turn) drops a whoosh or impact peak-aligned to each cut at `sfxGainDb` (−6.9 dB, ≈0.45) on a free audio track. Answers `cuts` [{frame, track, effect, transition, frames, sfx}] and `skipped` cuts with the reason."
        }
        "trim.applyDefaultTransition" => {
            "Adds the default video/audio transition at each edge of the selected clips (centred on cuts, at a free edge otherwise), or at the selected edit points when no clips are selected. Edges that already have a transition keep it."
        }
        "trim.backward" => {
            "Trims every selected edit point one frame earlier, using each point's ripple/roll/trim type. Needs selected edit points; use trim.nudge for any number of frames."
        }
        "trim.backwardMany" => "Trims every selected edit point earlier by the Large Trim Offset preference (5 frames by default). Needs selected edit points.",
        "trim.cancelDynamic" => "Abandons a dynamic (J/L) trim in progress without committing it; the edit points return to where the trim started.",
        "trim.clear" => "Deselects all edit points and leaves trim mode; changes no clips.",
        "trim.edit" => "Enters trim mode: selects the roll edit point nearest the playhead on targeted tracks if none is selected. Answers {editPoints}.",
        "trim.extendNextEdit" => {
            "On each targeted, unlocked track, moves the nearest edit after the playhead back to the playhead: a cut between clips rolls, an edge beside a gap trims; nothing ripples."
        }
        "trim.extendPreviousEdit" => {
            "On each targeted, unlocked track, moves the nearest edit before the playhead forward to the playhead: a cut between clips rolls, an edge beside a gap trims; nothing ripples."
        }
        "trim.extendToPlayhead" => {
            "Moves every selected edit point by the distance from the first one to the playhead, keeping each point's trim type. Needs selected edit points."
        }
        "trim.forward" => {
            "Trims every selected edit point one frame later, using each point's ripple/roll/trim type. Needs selected edit points; use trim.nudge for any number of frames."
        }
        "trim.forwardMany" => "Trims every selected edit point later by the Large Trim Offset preference (5 frames by default). Needs selected edit points.",
        "trim.monitor" => {
            "Reads the Trim Monitor for the first selected edit point: kind, edge, the outgoing and incoming clips' frames and the trim shift. Answers {active:false} with no edit point."
        }
        "trim.next" => {
            "Trims the clip edge at the next edit on targeted tracks back to the playhead, removing that material and leaving a gap (no ripple). Use trim.rippleNext to close the gap."
        }
        "trim.nudge" => {
            "Trims every selected edit point by `frames` (sequence frames; negative is earlier), using each point's ripple/roll/trim type. Needs selected edit points."
        }
        "trim.playAround" => {
            "Plays from preroll before the first selected edit to postroll after it (loops by default); `clock` is the caller's playback time in seconds, `toggle` stops it if playing."
        }
        "trim.previous" => {
            "Trims the clip edge at the previous edit on targeted tracks up to the playhead, removing that material and leaving a gap (no ripple). Use trim.ripplePrevious to close the gap."
        }
        "trim.rippleNext" => {
            "Removes the material between the playhead and the next edit on targeted tracks and closes the gap by moving later clips earlier (Premiere W)."
        }
        "trim.ripplePrevious" => {
            "Removes the material between the previous edit and the playhead on targeted tracks and closes the gap by moving later clips earlier (Premiere Q)."
        }
        "trim.selectEditPoint" => {
            "Selects the `edge` (in|out) of `clip` as an edit point of `kind` trim|ripple|roll; `add` keeps the existing edit points. The first step before trim.nudge or trim.shuttle."
        }
        "trim.selectNearest" => {
            "Selects, on each targeted track (all tracks when none), the edit point nearest the playhead as `kind` rippleIn|rippleOut|roll|trimIn|trimOut."
        }
        "trim.shuttle" => {
            "Starts or speeds up a dynamic trim of the selected edit points in `direction` (pressing again doubles speed up to 8×, `slow` for slow); `clock` is playback time in seconds. Commit with trim.shuttleStop."
        }
        "trim.shuttleStop" => "Stops a dynamic trim and commits it as one undo step, and stops trim loop playback; `clock` is the playback time in seconds.",
        "trim.tick" => {
            "Advances a dynamic trim or Play Around Edit to playback time `clock` (seconds) and answers the trim status; the host calls it while playing."
        }
        "trim.toggleType" => "Cycles every selected edit point Ripple → Roll → Trim.",
        _ => "",
    }
}

/// Reading commands that answer nothing, with why (kition-sdk `check_commands`' `no_output`).
pub const NO_OUTPUT: &[(&str, &str)] = &[("masks.select", "answers nothing (null): it changes view or session state only")];
