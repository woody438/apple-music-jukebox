-- Write the current track's first artwork to a file as raw bytes.
-- The caller sniffs the magic bytes for the content type.
-- read/write needs StandardAdditions, so the file work sits OUTSIDE the
-- tell block -- inside it, "open for access" would be sent to Music.
on run argv
	set outPath to item 1 of argv
	set d to missing value
	tell application "Music"
		if player state is stopped then error "NOTPLAYING"
		set t to current track
		if (count of artworks of t) is 0 then error "NOART"
		set d to raw data of artwork 1 of t
	end tell
	set fh to open for access (POSIX file outPath) with write permission
	try
		set eof fh to 0
		write d to fh
		close access fh
	on error errMsg
		try
			close access fh
		end try
		error errMsg
	end try
	return "ok"
end run
