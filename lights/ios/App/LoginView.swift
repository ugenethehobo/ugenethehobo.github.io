import SwiftUI

struct LoginView: View {
    @EnvironmentObject private var model: AppModel
    @State private var server = SharedStore.serverURL?.absoluteString ?? ""
    @State private var name = SharedStore.name ?? ""
    @State private var passcode = ""
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 8) {
                        Image(systemName: "lightbulb.2.fill")
                            .font(.system(size: 44))
                            .foregroundStyle(.orange, .red)
                        Text("Your Hue lights, without the bridge")
                            .font(.headline)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                }
                Section {
                    TextField("home-lights.you.workers.dev", text: $server)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Server address")
                } footer: {
                    Text("Shown in Cloudflare after you deploy the lights server.")
                }
                Section {
                    TextField("Your name", text: $name)
                        .textContentType(.givenName)
                    SecureField("Household passcode", text: $passcode)
                } header: {
                    Text("You")
                } footer: {
                    Text("On a brand-new server, the passcode you type here becomes the household passcode (6 or more characters).")
                }
                if let error = model.error {
                    Section {
                        Text(error)
                            .foregroundStyle(.red)
                    }
                }
                Section {
                    Button {
                        busy = true
                        Task {
                            await model.signIn(server: server, name: name, passcode: passcode)
                            busy = false
                        }
                    } label: {
                        HStack {
                            Spacer()
                            if busy { ProgressView() } else { Text("Sign in").bold() }
                            Spacer()
                        }
                    }
                    .disabled(busy || server.isEmpty || name.isEmpty || passcode.isEmpty)
                }
            }
            .navigationTitle("Lights")
        }
    }
}
