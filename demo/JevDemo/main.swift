import AppKit
import SwiftUI

// MARK: - Model

enum Role { case user, assistant, toolHeader, toolLine }

enum Verdict: Equatable {
    case keep(String)
    case drop(String)

    var isDrop: Bool {
        if case .drop = self { return true }
        return false
    }
}

struct Chunk: Identifiable, Equatable {
    let id: Int
    let role: Role
    let text: String
    let kind: String
    let drop: Double
    let recent: Bool

    var verdict: Verdict {
        if recent { return .keep("recent") }
        if kind == "user_instruction" || kind == "pending_task" { return .keep("protected") }
        if drop >= 0.8 { return .drop(String(format: "drop %.2f", drop)) }
        if drop >= 0.5 { return .keep(String(format: "%.2f < 0.80", drop)) }
        return .keep(String(format: "drop %.2f", drop))
    }
}

let transcript: [Chunk] = {
    var id = 0
    func c(_ role: Role, _ text: String, _ kind: String, _ drop: Double, recent: Bool = false) -> Chunk {
        id += 1
        return Chunk(id: id, role: role, text: text, kind: kind, drop: drop, recent: recent)
    }
    return [
        c(.user, "Fix the checkout parser so parseLineItems handles quantities over 999 without truncating. Keep the public API unchanged.", "user_instruction", 0.06),
        c(.assistant, "I'll read the parser and its tests first.", "chatter", 0.93),
        c(.toolHeader, "Read(src/checkout/parser.ts)", "file_reference", 0.41),
        c(.toolLine, "Read 212 lines", "stale_tool_output", 0.97),
        c(.toolLine, "41  const qty = Number(raw.slice(0, 3));", "file_reference", 0.22),
        c(.toolLine, "42  if (Number.isNaN(qty)) throw new ParseError(raw);", "stale_tool_output", 0.89),
        c(.toolLine, "43  return { sku, qty, price };", "stale_tool_output", 0.91),
        c(.toolHeader, "Bash(npm test -- parser)", "stale_tool_output", 0.84),
        c(.toolLine, "FAIL tests/parser.test.ts > parses quantities over 999", "error", 0.09),
        c(.toolLine, "expected 1200, received 120", "error", 0.11),
        c(.toolLine, "Tests: 1 failed, 23 passed", "stale_tool_output", 0.95),
        c(.toolLine, "Duration 1.42s", "stale_tool_output", 0.98),
        c(.assistant, "slice(0, 3) truncates to three digits. I'll capture the full quantity with a regex instead.", "decision", 0.14),
        c(.assistant, "Let me check where parseLineItems is called.", "chatter", 0.92),
        c(.toolHeader, "Grep(parseLineItems)", "stale_tool_output", 0.86),
        c(.toolLine, "src/checkout/index.ts:14", "file_reference", 0.33),
        c(.toolLine, "src/api/orders.ts:88", "file_reference", 0.35),
        c(.toolLine, "tests/parser.test.ts:5", "stale_tool_output", 0.88),
        c(.toolHeader, "Edit(src/checkout/parser.ts)", "decision", 0.79),
        c(.toolLine, "Updated 1 file (+3 -1)", "stale_tool_output", 0.90),
        c(.assistant, "Still to do: make sure the raw line appears in ParseError messages.", "pending_task", 0.12),
        c(.toolHeader, "Bash(npm test)", "stale_tool_output", 0.0, recent: true),
        c(.toolLine, "Tests: 24 passed", "stale_tool_output", 0.0, recent: true),
        c(.assistant, "All 24 tests pass and the public API is unchanged.", "decision", 0.0, recent: true),
        c(.user, "Great — now handle the ParseError message.", "user_instruction", 0.0, recent: true),
    ]
}()

// MARK: - Palette

enum Palette {
    static let bg = Color(red: 0.07, green: 0.07, blue: 0.09)
    static let panel = Color(red: 0.10, green: 0.10, blue: 0.12)
    static let fg = Color(red: 0.90, green: 0.90, blue: 0.92)
    static let dim = Color(red: 0.52, green: 0.53, blue: 0.58)
    static let border = Color(red: 0.24, green: 0.24, blue: 0.28)
    static let orange = Color(red: 0.85, green: 0.47, blue: 0.24)
    static let green = Color(red: 0.30, green: 0.85, blue: 0.48)
    static let red = Color(red: 0.96, green: 0.30, blue: 0.33)
    static let amber = Color(red: 0.98, green: 0.72, blue: 0.24)
    static let cyan = Color(red: 0.40, green: 0.78, blue: 0.95)
}

// MARK: - State

enum Phase { case idle, typing, waiting, scanning, collapsing, done }

struct ScrollRequest: Equatable {
    let id: Int
    let anchor: UnitPoint?
    let serial: Int
}

@MainActor
final class Demo: ObservableObject {
    @Published var visible: [Chunk] = []
    @Published var typed: [Int: Int] = [:]
    @Published var revealed: Set<Int> = []
    @Published var phase: Phase = .idle
    @Published var beamY: CGFloat? = nil
    @Published var context: Double = 0.06
    @Published var status: String = ""
    @Published var summary: String? = nil
    @Published var scroll: ScrollRequest? = nil

    private var task: Task<Void, Never>?
    private var scrollSerial = 0
    var frames: [Int: CGRect] = [:]

    func scrollTo(_ id: Int, anchor: UnitPoint?) {
        scrollSerial += 1
        scroll = ScrollRequest(id: id, anchor: anchor, serial: scrollSerial)
    }

    func restart() {
        task?.cancel()
        visible = []
        typed = [:]
        revealed = []
        beamY = nil
        context = 0.06
        status = ""
        summary = nil
        phase = .idle
        task = Task { await run() }
    }

    private func sleep(_ s: Double) async throws {
        try await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000))
    }

    private func run() async {
        do {
            try await sleep(1.2)
            phase = .typing
            let perChunk = 0.72 / Double(transcript.count)
            for chunk in transcript {
                withAnimation(.spring(duration: 0.35)) {
                    visible.append(chunk)
                    context += perChunk
                }
                scrollTo(chunk.id, anchor: .bottom)
                switch chunk.role {
                case .user, .assistant:
                    typed[chunk.id] = 0
                    let delay = chunk.role == .user ? 0.022 : 0.012
                    for i in 1...chunk.text.count {
                        typed[chunk.id] = i
                        try await sleep(delay)
                    }
                    try await sleep(0.28)
                case .toolHeader:
                    try await sleep(0.32)
                case .toolLine:
                    try await sleep(0.11)
                }
            }

            phase = .waiting
            status = "Context window at \(Int(context * 100))% — running fast-jev-compaction"
            try await sleep(1.6)

            phase = .scanning
            let candidates = transcript.filter { !$0.recent }.count
            status = "✻ Asking jev-latest \(candidates * 2) questions (\(candidates) chunks × removable? + kind)…"
            try await sleep(0.9)

            for chunk in transcript {
                scrollTo(chunk.id, anchor: nil)
                try await sleep(0.02)
                if let f = frames[chunk.id] {
                    withAnimation(.linear(duration: 0.09)) { beamY = f.maxY }
                }
                try await sleep(0.05)
                withAnimation(.easeOut(duration: 0.25)) { _ = revealed.insert(chunk.id) }
                try await sleep(0.07)
            }
            try await sleep(0.4)
            withAnimation(.easeOut(duration: 0.4)) { beamY = nil }
            let dropped = transcript.filter { $0.verdict.isDrop }
            status = "\(dropped.count) chunks marked safe to drop · \(transcript.count - dropped.count) kept verbatim"
            try await sleep(1.7)

            phase = .collapsing
            status = "Deleting dropped chunks…"
            if let first = transcript.first { scrollTo(first.id, anchor: .top) }
            try await sleep(0.5)
            let charsBefore = transcript.reduce(0) { $0 + $1.text.count }
            let charsAfter = transcript.filter { !$0.verdict.isDrop }.reduce(0) { $0 + $1.text.count }
            for chunk in dropped {
                scrollTo(chunk.id, anchor: nil)
                try await sleep(0.05)
                withAnimation(.easeInOut(duration: 0.42)) {
                    visible.removeAll { $0.id == chunk.id }
                    context -= 0.72 / Double(transcript.count) * 1.35
                }
                try await sleep(0.24)
            }
            try await sleep(0.4)
            withAnimation(.spring(duration: 0.8)) { context = 0.31 }
            phase = .done
            status = "✓ Compacted in 148 ms"
            summary = "\(transcript.count) chunks → \(transcript.count - dropped.count) kept · \(dropped.count) dropped · \(charsBefore) → \(charsAfter) chars · 1 request · 0 summaries · kept text is verbatim"
        } catch {}
    }
}

// MARK: - Views

struct FrameKey: PreferenceKey {
    static var defaultValue: [Int: CGRect] = [:]
    static func reduce(value: inout [Int: CGRect], nextValue: () -> [Int: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { $1 })
    }
}

let mono = Font.system(size: 15, design: .monospaced)
let monoSmall = Font.system(size: 12.5, design: .monospaced)

struct ChunkView: View {
    let chunk: Chunk
    let typedCount: Int?
    let revealed: Bool

    var shownText: String {
        if let n = typedCount { return String(chunk.text.prefix(n)) }
        return chunk.text
    }

    var tint: Color? {
        guard revealed else { return nil }
        return chunk.verdict.isDrop ? Palette.red : Palette.green
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            content
            Spacer(minLength: 12)
            if revealed {
                badge
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .padding(.vertical, 5)
        .padding(.horizontal, 10)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill((tint ?? .clear).opacity(chunk.verdict.isDrop ? 0.16 : 0.10))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(tint ?? (chunk.role == .user ? Palette.border : .clear), lineWidth: 1.2)
        )
        .shadow(color: (tint ?? .clear).opacity(0.45), radius: revealed ? 10 : 0)
    }

    @ViewBuilder var content: some View {
        switch chunk.role {
        case .user:
            HStack(alignment: .top, spacing: 8) {
                Text(">").foregroundStyle(Palette.dim)
                Text(shownText).foregroundStyle(Palette.fg)
            }
        case .assistant:
            HStack(alignment: .top, spacing: 8) {
                Text("●").foregroundStyle(Palette.orange)
                Text(shownText).foregroundStyle(Palette.fg)
            }
        case .toolHeader:
            HStack(alignment: .top, spacing: 8) {
                Text("●").foregroundStyle(Palette.green)
                toolTitle
            }
        case .toolLine:
            HStack(alignment: .top, spacing: 8) {
                Text("  ⎿").foregroundStyle(Palette.dim)
                Text(chunk.text).foregroundStyle(Palette.dim)
            }
        }
    }

    var toolTitle: some View {
        let name = chunk.text.prefix { $0 != "(" }
        let rest = chunk.text.dropFirst(name.count)
        return (Text(String(name)).bold().foregroundStyle(Palette.fg)
            + Text(String(rest)).foregroundStyle(Palette.dim))
    }

    var badge: some View {
        let color = tint ?? Palette.dim
        let label: String
        switch chunk.verdict {
        case .keep(let r): label = r
        case .drop(let r): label = r
        }
        return HStack(spacing: 6) {
            Text(chunk.recent ? "recent" : chunk.kind)
                .foregroundStyle(color.opacity(0.85))
            Text(chunk.verdict.isDrop ? "DROP" : "KEEP")
                .bold()
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background(RoundedRectangle(cornerRadius: 3).fill(color.opacity(0.22)))
                .foregroundStyle(color)
            if !chunk.recent {
                Text(label).foregroundStyle(color.opacity(0.7))
            }
        }
        .font(monoSmall)
        .fixedSize()
    }
}

struct ContextMeter: View {
    let value: Double
    let phase: Phase

    var color: Color {
        if phase == .done { return Palette.green }
        return value > 0.6 ? Palette.amber : Palette.dim
    }

    var body: some View {
        HStack(spacing: 8) {
            Text("Context")
                .foregroundStyle(Palette.dim)
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 3).fill(Palette.border).frame(width: 160, height: 8)
                RoundedRectangle(cornerRadius: 3).fill(color).frame(width: max(4, 160 * value), height: 8)
            }
            Text("\(Int(value * 100))%")
                .foregroundStyle(color)
                .frame(width: 44, alignment: .trailing)
                .contentTransition(.numericText())
        }
        .font(monoSmall)
    }
}

struct TerminalView: View {
    @ObservedObject var demo: Demo

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            banner
                .padding(.horizontal, 20)
                .padding(.top, 14)
                .padding(.bottom, 8)

            ScrollViewReader { proxy in
                ScrollView(.vertical, showsIndicators: false) {
                    LazyVStack(alignment: .leading, spacing: 3) {
                        ForEach(demo.visible) { chunk in
                            ChunkView(
                                chunk: chunk,
                                typedCount: demo.typed[chunk.id],
                                revealed: demo.revealed.contains(chunk.id)
                            )
                            .id(chunk.id)
                            .background(GeometryReader { g in
                                Color.clear.preference(
                                    key: FrameKey.self,
                                    value: [chunk.id: g.frame(in: .named("transcript"))]
                                )
                            })
                            .transition(.asymmetric(
                                insertion: .move(edge: .bottom).combined(with: .opacity),
                                removal: .scale(scale: 0.85, anchor: .leading)
                                    .combined(with: .move(edge: .trailing))
                                    .combined(with: .opacity)
                            ))
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 6)
                }
                .coordinateSpace(name: "transcript")
                .onPreferenceChange(FrameKey.self) { frames in
                    demo.frames.merge(frames, uniquingKeysWith: { $1 })
                }
                .overlay(alignment: .top) {
                    if let y = demo.beamY {
                        beam.offset(y: y - 14)
                    }
                }
                .onChange(of: demo.scroll) { _, request in
                    if let request {
                        withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(request.id, anchor: request.anchor) }
                    }
                }
                .onChange(of: demo.typed) { _, _ in
                    if let request = demo.scroll, demo.phase == .typing {
                        proxy.scrollTo(request.id, anchor: .bottom)
                    }
                }
            }
            .font(mono)
            .clipped()

            footer
                .padding(.horizontal, 20)
                .padding(.bottom, 14)
                .padding(.top, 8)
        }
        .background(Palette.bg)
    }

    var beam: some View {
        VStack(spacing: 0) {
            LinearGradient(colors: [.clear, Palette.cyan.opacity(0.18)], startPoint: .top, endPoint: .bottom)
                .frame(height: 26)
            Rectangle().fill(Palette.cyan).frame(height: 2)
                .shadow(color: Palette.cyan, radius: 8)
        }
        .allowsHitTesting(false)
    }

    var banner: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Text("✻").foregroundStyle(Palette.orange)
                Text("Welcome to Claude Code!").bold().foregroundStyle(Palette.fg)
            }
            Text("  /help for help, /status for your current setup").foregroundStyle(Palette.dim)
            Text("  cwd: ~/work/checkout-service").foregroundStyle(Palette.dim)
            HStack(spacing: 0) {
                Text("  compaction: ").foregroundStyle(Palette.dim)
                Text("fast-jev-compaction").foregroundStyle(Palette.cyan)
                Text(" · jev-latest · verbatim, no summaries").foregroundStyle(Palette.dim)
            }
        }
        .font(mono)
        .padding(.vertical, 10)
        .padding(.horizontal, 14)
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.orange.opacity(0.7), lineWidth: 1))
    }

    var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            statusLine
            HStack(spacing: 8) {
                Text(">").foregroundStyle(Palette.dim)
                Text(demo.phase == .done ? "" : " ")
                Rectangle().fill(Palette.fg).frame(width: 9, height: 18).opacity(cursorOn ? 1 : 0)
                Spacer()
            }
            .font(mono)
            .padding(.vertical, 8)
            .padding(.horizontal, 12)
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.border, lineWidth: 1))
            HStack {
                Text("? for shortcuts").foregroundStyle(Palette.dim).font(monoSmall)
                Spacer()
                ContextMeter(value: demo.context, phase: demo.phase)
            }
        }
    }

    @State private var cursorOn = true

    @ViewBuilder var statusLine: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                if demo.phase == .scanning || demo.phase == .collapsing {
                    Spinner()
                }
                Text(demo.status)
                    .foregroundStyle(statusColor)
                    .contentTransition(.opacity)
            }
            if let summary = demo.summary {
                Text(summary)
                    .foregroundStyle(Palette.dim)
                    .transition(.opacity)
            }
        }
        .font(monoSmall)
        .frame(minHeight: 36, alignment: .leading)
        .animation(.easeInOut(duration: 0.3), value: demo.status)
        .animation(.easeInOut(duration: 0.3), value: demo.summary)
    }

    var statusColor: Color {
        switch demo.phase {
        case .waiting: return Palette.amber
        case .scanning, .collapsing: return Palette.cyan
        case .done: return Palette.green
        default: return Palette.dim
        }
    }
}

struct Spinner: View {
    @State private var index = 0
    private let frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

    var body: some View {
        Text(frames[index])
            .foregroundStyle(Palette.cyan)
            .onReceive(Timer.publish(every: 0.08, on: .main, in: .common).autoconnect()) { _ in
                index = (index + 1) % frames.count
            }
    }
}

struct RootView: View {
    @StateObject private var demo = Demo()

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                Text("claude — checkout-service — 132×44")
                    .font(.system(size: 12.5))
                    .foregroundStyle(Palette.dim)
                Spacer()
            }
            .frame(height: 30)
            .background(Palette.panel)
            TerminalView(demo: demo)
        }
        .frame(minWidth: 1180, minHeight: 900)
        .background(Palette.bg)
        .onAppear {
            demo.restart()
            NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                if event.keyCode == 49 { // space
                    demo.restart()
                    return nil
                }
                return event
            }
        }
    }
}

@main
struct JevDemoApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentSize)
    }
}
