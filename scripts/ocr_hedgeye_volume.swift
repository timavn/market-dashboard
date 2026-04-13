import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count >= 2 else {
  fputs("Usage: swift ocr_hedgeye_volume.swift <image-path>\n", stderr)
  exit(1)
}

let imagePath = CommandLine.arguments[1]
let imageURL = URL(fileURLWithPath: imagePath)

guard let image = NSImage(contentsOf: imageURL) else {
  fputs("Failed to load image at \(imagePath)\n", stderr)
  exit(1)
}

var rect = NSRect(origin: .zero, size: image.size)
guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
  fputs("Failed to create CGImage from \(imagePath)\n", stderr)
  exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try handler.perform([request])

for observation in request.results ?? [] {
  if let text = observation.topCandidates(1).first?.string {
    print(text)
  }
}
