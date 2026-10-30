-- Empty the jukebox playlist. Playlist entries only -- the library is
-- untouched. Refuses anything that is not a plain user playlist.
on run argv
	set plName to item 1 of argv
	tell application "Music"
		if not (exists user playlist plName) then return "ok|0"
		set pl to (first user playlist whose name is plName)
		if (smart of pl) then error "REFUSE: " & plName & " is a smart playlist"
		set n to (count of tracks of pl)
		delete every track of pl
		return "ok|" & n
	end tell
end run
