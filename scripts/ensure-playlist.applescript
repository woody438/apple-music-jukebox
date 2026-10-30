-- Create the jukebox playlist if it is missing. Refuses to touch a smart
-- playlist. Prints "ok|<trackcount>".
on run argv
	set plName to item 1 of argv
	tell application "Music"
		if not (exists user playlist plName) then
			make new user playlist with properties {name:plName}
		end if
		set pl to (first user playlist whose name is plName)
		if (smart of pl) then error "REFUSE: " & plName & " is a smart playlist"
		return "ok|" & (count of tracks of pl)
	end tell
end run
