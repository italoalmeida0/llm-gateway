package tools

import (
	"bytes"
	"errors"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"math"
	"strconv"
	"strings"

	"golang.org/x/image/bmp"
	"golang.org/x/image/draw"
	"golang.org/x/image/webp"
)

const (
	imageMaxWidth  = 2000
	imageMaxHeight = 2000
	// Same as pi: 4.5MB of base64 payload, below providers' 5MB limit.
	imageMaxBase64Bytes = int(4.5 * 1024 * 1024)
	imageJPEGQuality    = 80
)

type processedImage struct {
	data           []byte
	mimeType       string
	originalWidth  int
	originalHeight int
	width          int
	height         int
	wasResized     bool
	hints          []string
}

var (
	errUnsupportedImage = errors.New("[Image omitted: could not be converted to a supported inline image format.]")
	errImageTooLarge    = errors.New("[Image omitted: could not be resized below the inline image size limit.]")
)

// processImage is the Go equivalent of pi's processImage/resizeImage. It
// normalizes supported images, limits dimensions to 2000x2000, tries PNG and
// JPEG encodings, then progressively reduces dimensions until the encoded
// base64 payload is below 4.5MB.
func processImage(input []byte, detectedMIME string) (*processedImage, error) {
	mimeType := normalizeImageMIME(detectedMIME)
	if mimeType == "" {
		return nil, errUnsupportedImage
	}

	cfg, format, err := decodeImageConfig(input)
	if err != nil {
		return nil, errUnsupportedImage
	}
	originalWidth, originalHeight := cfg.Width, cfg.Height
	inputBase64Size := ((len(input) + 2) / 3) * 4

	// PNG/JPEG/GIF/WebP can be passed through when already within limits.
	// BMP is converted to PNG, matching pi's normalizeImage behavior.
	if mimeType != "image/png" || format == "png" {
		if originalWidth <= imageMaxWidth && originalHeight <= imageMaxHeight && inputBase64Size < imageMaxBase64Bytes {
			return &processedImage{
				data: input, mimeType: mimeType,
				originalWidth: originalWidth, originalHeight: originalHeight,
				width: originalWidth, height: originalHeight,
			}, nil
		}
	}

	img, err := decodeImage(input, format)
	if err != nil {
		return nil, errUnsupportedImage
	}

	targetWidth, targetHeight := fitDimensions(originalWidth, originalHeight, imageMaxWidth, imageMaxHeight)
	qualitySteps := uniqueInts([]int{imageJPEGQuality, 85, 70, 55, 40})
	for {
		for _, candidate := range encodeImageCandidates(img, targetWidth, targetHeight, qualitySteps) {
			encodedSize := ((len(candidate.data) + 2) / 3) * 4
			if encodedSize >= imageMaxBase64Bytes {
				continue
			}
			hints := []string{}
			if candidate.mimeType != mimeType {
				hints = append(hints, "[Image converted from "+mimeType+" to "+candidate.mimeType+".]")
			}
			if targetWidth != originalWidth || targetHeight != originalHeight {
				scale := float64(originalWidth) / float64(targetWidth)
				hints = append(hints, "[Image: original "+strconv.Itoa(originalWidth)+"x"+strconv.Itoa(originalHeight)+", displayed at "+strconv.Itoa(targetWidth)+"x"+strconv.Itoa(targetHeight)+". Multiply coordinates by "+strconv.FormatFloat(scale, 'f', 2, 64)+" to map to original image.]")
			}
			return &processedImage{
				data: candidate.data, mimeType: candidate.mimeType,
				originalWidth: originalWidth, originalHeight: originalHeight,
				width: targetWidth, height: targetHeight,
				wasResized: targetWidth != originalWidth || targetHeight != originalHeight,
				hints:      hints,
			}, nil
		}

		if targetWidth == 1 && targetHeight == 1 {
			break
		}
		nextWidth := maxInt(1, int(math.Floor(float64(targetWidth)*0.75)))
		nextHeight := maxInt(1, int(math.Floor(float64(targetHeight)*0.75)))
		if nextWidth == targetWidth && nextHeight == targetHeight {
			break
		}
		targetWidth, targetHeight = nextWidth, nextHeight
	}
	return nil, errImageTooLarge
}

type encodedImage struct {
	data     []byte
	mimeType string
}

func encodeImageCandidates(src image.Image, width, height int, qualities []int) []encodedImage {
	resized := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.CatmullRom.Scale(resized, resized.Bounds(), src, src.Bounds(), draw.Over, nil)

	candidates := make([]encodedImage, 0, len(qualities)+1)
	var pngBuffer bytes.Buffer
	if err := png.Encode(&pngBuffer, resized); err == nil {
		candidates = append(candidates, encodedImage{data: pngBuffer.Bytes(), mimeType: "image/png"})
	}
	for _, quality := range qualities {
		var jpegBuffer bytes.Buffer
		if err := jpeg.Encode(&jpegBuffer, resized, &jpeg.Options{Quality: quality}); err == nil {
			candidates = append(candidates, encodedImage{data: jpegBuffer.Bytes(), mimeType: "image/jpeg"})
		}
	}
	return candidates
}

func decodeImageConfig(data []byte) (image.Config, string, error) {
	// Try the standard formats first. WebP and BMP are handled explicitly.
	if cfg, format, err := image.DecodeConfig(bytes.NewReader(data)); err == nil {
		return cfg, format, nil
	}
	if cfg, err := webp.DecodeConfig(bytes.NewReader(data)); err == nil {
		return cfg, "webp", nil
	}
	if cfg, err := bmp.DecodeConfig(bytes.NewReader(data)); err == nil {
		return cfg, "bmp", nil
	}
	return image.Config{}, "", errors.New("unsupported image")
}

func decodeImage(data []byte, format string) (image.Image, error) {
	switch format {
	case "webp":
		return webp.Decode(bytes.NewReader(data))
	case "bmp":
		return bmp.Decode(bytes.NewReader(data))
	case "gif":
		return gif.Decode(bytes.NewReader(data))
	default:
		img, _, err := image.Decode(bytes.NewReader(data))
		return img, err
	}
}

func normalizeImageMIME(mime string) string {
	mime = strings.ToLower(strings.TrimSpace(strings.Split(mime, ";")[0]))
	switch mime {
	case "image/png":
		return "image/png"
	case "image/jpeg", "image/jpg":
		return "image/jpeg"
	case "image/gif":
		return "image/gif"
	case "image/webp":
		return "image/webp"
	case "image/bmp":
		// BMP is decoded and re-encoded as PNG before going to the provider.
		return "image/png"
	default:
		return ""
	}
}

func fitDimensions(width, height, maxWidth, maxHeight int) (int, int) {
	w, h := width, height
	if w > maxWidth {
		h = int(math.Round(float64(h) * float64(maxWidth) / float64(w)))
		w = maxWidth
	}
	if h > maxHeight {
		w = int(math.Round(float64(w) * float64(maxHeight) / float64(h)))
		h = maxHeight
	}
	return maxInt(1, w), maxInt(1, h)
}

func uniqueInts(values []int) []int {
	seen := make(map[int]bool, len(values))
	out := make([]int, 0, len(values))
	for _, value := range values {
		if !seen[value] {
			seen[value] = true
			out = append(out, value)
		}
	}
	return out
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
