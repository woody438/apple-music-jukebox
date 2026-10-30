-- Delete a user playlist outright. Only ever called by preflight.js against
-- its own scratch playlist. Refuses smart playlists.
on run argv
	set plName to item 1 of argv
	tell application "Music"
		if not (exists user playlist plName) then return "ok|absent"
		set pl to (first user playlist whose name is plName)
		if (smart of pl) then error "REFUSE: " & plName & " is a smart playlist"
		delete pl
		return "ok|deleted"
	end tell
end run
