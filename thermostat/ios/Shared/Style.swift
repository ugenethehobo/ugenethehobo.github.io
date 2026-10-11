import SwiftUI

extension ModeOption {
    var color: Color {
        switch self {
        case .heat: return .orange
        case .cool: return .blue
        case .smart: return .purple
        case .off: return .gray
        }
    }
}
