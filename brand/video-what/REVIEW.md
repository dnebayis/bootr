# how bootr works: review

Checked: `check` ok, frames at 1, 5, 7.9, 8.6, 10.5, 11.95, 14, 18.5, 20.4, 23.9, 27.5, 31.5, 33.8, 35, 36.2, 37.5, 39.9, 42, 45.5, 46.8, 50.5.

Fixed on review:
- "platform 30%" ran past its bar: labels down to 72 px.
- Share title sat on the bar: bar moved down.
- Post text hit its label: label moved to the header.
- Three titles showed for a moment before typing in: hidden until their time.
- Dimming the 65% and 30% segments hid the point: dim removed.

Left as they are, weighed:
- The post is 45 words on screen for about 4.5 s. The blue sentence is what it asks you to read; the rest is proof it is a real post.
- The Base square reads as a plain white square, with "on base." beside it.
- Footnote and claim are under their reading floor, as small print to pause on.

Not checked: sound by ear. Loudness is measured only: -16 LUFS after the post-render step below.

Re-render step: `ffmpeg -i in.mp4 -c:v copy -af "volume=3.6dB,alimiter=limit=0.85:level=disabled" -c:a aac -b:a 192k out.mp4`
