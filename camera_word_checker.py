"""
Point your webcam at a screen showing "Is this a real English word?"
The script reads the big word with OCR and shows YES / NO live.

Setup:
    pip install opencv-python easyocr nltk

Optional (bigger coverage): download words_alpha.txt from
    https://github.com/dwyl/english-words
and put it next to this file.

Run:
    python camera_word_checker.py
Press q to quit.
"""
import os

import cv2
import easyocr
import nltk
from nltk.corpus import wordnet

nltk.download("wordnet", quiet=True)

# Words from the question text that we should ignore
IGNORE = {"is", "this", "a", "real", "english", "word", "yes", "no"}

# Load optional word list
WORD_SET = set()
if os.path.exists("words_alpha.txt"):
    with open("words_alpha.txt", encoding="utf-8") as f:
        WORD_SET = {line.strip().lower() for line in f}


def is_english_word(word: str) -> bool:
    word = word.lower().strip()
    if not word.isalpha():
        return False
    return word in WORD_SET or len(wordnet.synsets(word)) > 0


def find_target_word(results):
    """Pick the largest alphabetic text box that isn't part of the question."""
    best, best_height = None, 0
    for box, text, conf in results:
        text = text.strip().lower()
        if conf < 0.4 or not text.isalpha() or text in IGNORE:
            continue
        height = box[3][1] - box[0][1]  # box height in pixels
        if height > best_height:
            best, best_height = text, height
    return best


def main():
    reader = easyocr.Reader(["en"], gpu=False)
    cap = cv2.VideoCapture(0)
    frame_count = 0
    word, verdict = None, None

    while True:
        ok, frame = cap.read()
        if not ok:
            break

        frame_count += 1
        # OCR is slow, so only run it every 15 frames
        if frame_count % 15 == 0:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            results = reader.readtext(gray)
            found = find_target_word(results)
            if found:
                word = found
                verdict = is_english_word(found)

        if word is not None:
            color = (0, 200, 0) if verdict else (0, 0, 255)
            label = f"{word}: {'YES (real word)' if verdict else 'NO (not a word)'}"
            cv2.putText(frame, label, (20, 50),
                        cv2.FONT_HERSHEY_SIMPLEX, 1, color, 2)

        cv2.imshow("Word checker", frame)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
