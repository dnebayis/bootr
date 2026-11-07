# the trailer: review

Checked: `check` ok, frames at 0.5, 6, 10.2, 12.5, 15, 16.6, 17.9, 19.9, 22, 25.5, 29.5, 31.5, 33, 35, 37, 39, 41.5, 45.5.

Fixed on review: "for base." ran out of the rating box; n2 and n3 overlapped; the eyes had two tweens at once; "your turn." held longer.

Left as is: "$YOURS" grows over its neighbours in the wall on purpose, the rest are dimmed to near black.

Not checked: the voices and score by ear. Brian and Callum were picked from ElevenLabs' premade descriptions, since the key cannot list voices.
Re-render step: `ffmpeg -i in.mp4 -c:v copy -af "volume=1.2dB,alimiter=limit=0.85:level=disabled" -c:a aac -b:a 192k out.mp4`. Voice clips carry +7 dB baked in. Loudness about -16 LUFS, measured only.
