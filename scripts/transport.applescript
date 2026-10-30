-- Transport and volume. One script, one verb argument.
on run argv
	set verb to item 1 of argv
	tell application "Music"
		if verb is "play" then
			play
		else if verb is "pause" then
			pause
		else if verb is "playpause" then
			playpause
		else if verb is "next" then
			next track
		else if verb is "volume" then
			set sound volume to (item 2 of argv) as integer
		else if verb is "reset-modes" then
			try
				set shuffle enabled to false
			end try
			try
				set song repeat to off
			end try
		else
			error "UNKNOWN VERB: " & verb
		end if
		return "ok"
	end tell
end run
