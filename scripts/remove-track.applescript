-- Remove entries for one persistent ID from the jukebox playlist.
-- delete on a track of a USER playlist removes the playlist entry only; the
-- library track is untouched. Never run this against a library playlist.
on run argv
	set plName to item 1 of argv
	set pid to item 2 of argv
	tell application "Music"
		set pl to (first user playlist whose name is plName)
		if (smart of pl) then error "REFUSE: " & plName & " is a smart playlist"
		set matches to (every track of pl whose persistent ID is pid)
		set n to (count of matches)
		repeat with i from n to 1 by -1
			delete (item i of matches)
		end repeat
		return "ok|" & n
	end tell
end run
