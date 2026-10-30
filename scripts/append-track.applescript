-- Append one library track to the end of the jukebox playlist, by persistent
-- ID. Duplicating a library track into a user playlist adds a playlist entry;
-- it does not copy the file or alter the library.
on run argv
	set plName to item 1 of argv
	set pid to item 2 of argv
	tell application "Music"
		set pl to (first user playlist whose name is plName)
		if (smart of pl) then error "REFUSE: " & plName & " is a smart playlist"
		set matches to (every track of library playlist 1 whose persistent ID is pid)
		if (count of matches) is 0 then error "NOTFOUND: " & pid
		duplicate (item 1 of matches) to pl
		return "ok|" & (count of tracks of pl)
	end tell
end run
