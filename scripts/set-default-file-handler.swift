import CoreServices
import Foundation
import UniformTypeIdentifiers

guard CommandLine.arguments.count == 4 else {
  FileHandle.standardError.write(
    Data("Usage: set-default-file-handler.swift <bundle-id> <declared-uti> <extension>\n".utf8)
  )
  exit(2)
}

let bundleID = CommandLine.arguments[1]
let declaredType = CommandLine.arguments[2]
let filenameExtension = CommandLine.arguments[3]
var contentTypes = [declaredType]

if let inferredType = UTType(filenameExtension: filenameExtension)?.identifier,
   !contentTypes.contains(inferredType) {
  contentTypes.append(inferredType)
}

for contentType in contentTypes {
  let status = LSSetDefaultRoleHandlerForContentType(
    contentType as CFString,
    .all,
    bundleID as CFString
  )
  guard status == noErr else {
    FileHandle.standardError.write(
      Data("Could not set the default handler for \(contentType) (status \(status)).\n".utf8)
    )
    exit(1)
  }
}

for contentType in contentTypes {
  guard let handler = LSCopyDefaultRoleHandlerForContentType(
    contentType as CFString,
    .all
  )?.takeRetainedValue() as String?, handler == bundleID else {
    FileHandle.standardError.write(
      Data("macOS did not retain \(bundleID) as the handler for \(contentType).\n".utf8)
    )
    exit(1)
  }
}

print("Default handler for .\(filenameExtension): \(bundleID)")
