package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"os"
)

func writeICO(path, source string) error {
	sizes := []int{16, 32, 48, 256}
	header := make([]byte, 6+16*len(sizes))
	binary.LittleEndian.PutUint16(header[2:], 1)
	binary.LittleEndian.PutUint16(header[4:], uint16(len(sizes)))
	var payload bytes.Buffer
	for index, size := range sizes {
		data, err := rasterize(source, size)
		if err != nil {
			return err
		}
		img, err := png.Decode(bytes.NewReader(data))
		if err != nil {
			return err
		}
		bitmap := iconBitmap(img)
		entry := header[6+index*16:]
		entry[0], entry[1] = byte(size), byte(size)
		binary.LittleEndian.PutUint16(entry[4:], 1)
		binary.LittleEndian.PutUint16(entry[6:], 32)
		binary.LittleEndian.PutUint32(entry[8:], uint32(len(bitmap)))
		binary.LittleEndian.PutUint32(entry[12:], uint32(len(header)+payload.Len()))
		payload.Write(bitmap)
	}
	return os.WriteFile(path, append(header, payload.Bytes()...), 0644)
}

func iconBitmap(img image.Image) []byte {
	size := img.Bounds().Dx()
	maskStride := ((size + 31) / 32) * 4
	bitmapSize := size * size * 4
	data := make([]byte, 40+bitmapSize+maskStride*size)
	binary.LittleEndian.PutUint32(data, 40)
	binary.LittleEndian.PutUint32(data[4:], uint32(size))
	binary.LittleEndian.PutUint32(data[8:], uint32(size*2))
	binary.LittleEndian.PutUint16(data[12:], 1)
	binary.LittleEndian.PutUint16(data[14:], 32)
	binary.LittleEndian.PutUint32(data[20:], uint32(bitmapSize))
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			pixel := color.NRGBAModel.Convert(img.At(x, size-y-1)).(color.NRGBA)
			offset := 40 + (y*size+x)*4
			copy(data[offset:], []byte{pixel.B, pixel.G, pixel.R, pixel.A})
			if pixel.A == 0 {
				data[40+bitmapSize+y*maskStride+x/8] |= 1 << (7 - x%8)
			}
		}
	}
	return data
}
