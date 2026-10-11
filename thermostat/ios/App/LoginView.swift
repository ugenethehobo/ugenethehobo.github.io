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
                    TextField("home-climate.you.workers.dev", text: $server)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Server address")
                } footer: {
                    Text("The address you open the web app at.")
                }
                Section("You") {
                    TextField("Your name", text: $name)
                        .textContentType(.givenName)
                    SecureField("Household passcode", text: $passcode)
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
            .navigationTitle("Climate")
        }
    }
}
