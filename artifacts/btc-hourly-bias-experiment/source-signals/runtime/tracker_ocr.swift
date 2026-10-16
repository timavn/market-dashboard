
import Foundation
import Vision
import AppKit
let path = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile:path) else { exit(2) }
var rect = NSRect(origin:.zero,size:image.size)
guard let cg = image.cgImage(forProposedRect:&rect,context:nil,hints:nil) else { exit(3) }
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = false
try VNImageRequestHandler(cgImage:cg,options:[:]).perform([req])
let rows:[[String:Any]] = (req.results ?? []).compactMap { r in
    guard let t = r.topCandidates(1).first else { return nil }
    return ["text":t.string,"confidence":t.confidence,
            "x":r.boundingBox.minX,"y":1-r.boundingBox.maxY,
            "width":r.boundingBox.width,"height":r.boundingBox.height]
}
let data = try JSONSerialization.data(withJSONObject:rows,options:[.sortedKeys])
print(String(data:data,encoding:.utf8)!)
