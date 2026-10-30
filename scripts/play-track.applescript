-- Play a specific track inside the jukebox playlist, by persistent ID.
-- Uses the LAST match: if the same song was queued twice, the later entry is
-- the one we have not played yet.
on run argv
	set plName to item 1 of argv
	set pid to item 2 of argv
	tell application "Music"
		-- Shuffle or repeat would break first-come-first-served ordering.
		-- Both are best-effort: never let a mode failure stop the music.
		try
			set shuffle enabled to false
		end try
		try
			set song repeat to off
		end try
		set pl to (first user playlist whose name is plName)
		set matches to (every track of pl whose persistent ID is pid)
		if (count of matches) is 0 then error "NOTFOUND: " & pid
		play (item (count of matches) of matches)
		return "ok"
	end tell
end run
