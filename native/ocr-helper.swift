import AppKit
import Foundation
import Vision

struct OCRLine: Encodable {
  let text: String
  let confidence: Float
  let boundingBox: [CGFloat]
}

struct OCRResult: Encodable {
  let text: String
  let lines: [OCRLine]
}

struct OCRError: Encodable {
  let error: String
}

func writeJSON<T: Encodable>(_ value: T) {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.withoutEscapingSlashes]

  do {
    let data = try encoder.encode(value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
  } catch {
    FileHandle.standardOutput.write(Data("{\"error\":\"Failed to encode JSON\"}\n".utf8))
  }
}

guard CommandLine.arguments.count >= 2 else {
  writeJSON(OCRError(error: "Missing image path"))
  exit(2)
}

let imagePath = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: imagePath) else {
  writeJSON(OCRError(error: "Unable to load image"))
  exit(3)
}

guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  writeJSON(OCRError(error: "Unable to create CGImage"))
  exit(4)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false

let preferredLanguages = ["zh-Hans", "en-US"]
if let supportedLanguages = try? request.supportedRecognitionLanguages() {
  let supportedSet = Set(supportedLanguages)
  let languages = preferredLanguages.filter { supportedSet.contains($0) }
  if !languages.isEmpty {
    request.recognitionLanguages = languages
  }
} else {
  request.recognitionLanguages = preferredLanguages
}

func collectResult(from request: VNRecognizeTextRequest) {
  let observations = request.results ?? []
  let lines = observations.compactMap { observation -> OCRLine? in
    guard let candidate = observation.topCandidates(1).first else {
      return nil
    }

    let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else {
      return nil
    }

    let box = observation.boundingBox
    return OCRLine(
      text: text,
      confidence: candidate.confidence,
      boundingBox: [box.origin.x, box.origin.y, box.size.width, box.size.height]
    )
  }
  writeJSON(OCRResult(text: lines.map(\.text).joined(separator: "\n"), lines: lines))
}

func perform(_ request: VNRecognizeTextRequest) throws {
  let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
  try handler.perform([request])
}

do {
  try perform(request)
  collectResult(from: request)
} catch {
  let fallbackRequest = VNRecognizeTextRequest()
  fallbackRequest.recognitionLevel = .accurate
  fallbackRequest.usesLanguageCorrection = false

  do {
    try perform(fallbackRequest)
    collectResult(from: fallbackRequest)
  } catch {
    writeJSON(OCRError(error: error.localizedDescription))
    exit(5)
  }
}
