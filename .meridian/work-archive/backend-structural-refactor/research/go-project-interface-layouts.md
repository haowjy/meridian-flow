# Go Project Interface/Contract Layer Layouts (Production Code Survey)

Scope: direct source-tree inspection of large Go projects (not blog posts). Focus is where interfaces/contracts live vs implementations, package naming, and boundary patterns.

## Executive answer

What large Go projects actually do is **mixed**, but there is a clear dominant pattern:

1. **No central global `interfaces` package** for everything.
2. **Interfaces usually live near the domain that consumes them** (or in a boundary SDK package), not in one architecture-theory folder.
3. **Implementations are split by mechanism** using explicit package names like `database`, `sqlstore`, `impl`, provider names (`amazon`, `nodelocal`), or plugin modules.
4. Terms like **`ports` / `usecases` / `contracts` are uncommon as top-level package names** in these projects.

For your case (`domain/services/billing` interfaces vs `service/billing` implementations), real-world naming suggests avoiding duplicated word roots (`service` vs `services`) because that creates exactly the confusion you’re seeing.

---

## 1) Kubernetes

### Observed layout

- Contract-heavy API server interfaces are in dedicated boundary packages:
  - `staging/src/k8s.io/apiserver/pkg/registry/rest/rest.go`
    - `type Storage interface`, `Lister`, `Getter`, etc.
  - `staging/src/k8s.io/apiserver/pkg/server/storage/storage_factory.go`
    - `type StorageFactory interface`
- Implementations are in different packages:
  - `staging/src/k8s.io/apiserver/pkg/registry/generic/registry/store.go`
    - `type Store struct`
    - compile assertions: `var _ rest.StandardStorage = &Store{}` and `var _ rest.StorageWithReadiness = &Store{}`

### Pattern call

- Not one global “interfaces” package.
- Contracts are grouped by subsystem boundary (`rest`, `storage`), then concrete stores/factories implement them elsewhere.

---

## 2) CockroachDB

### Observed layout

- Contract package explicitly separated from implementations for cloud storage:
  - `pkg/cloud/external_storage.go`
    - file comment: “interfaces only … concrete implementations … pkg/cloud/impl”
    - `type ExternalStorage interface`
- Implementations split by provider/mechanism:
  - `pkg/cloud/nodelocal/nodelocal_storage.go`
    - `type localFileStorage struct`
    - `var _ cloud.ExternalStorage = &localFileStorage{}`
  - `pkg/cloud/amazon/s3_storage.go`
    - `type s3Storage struct`
    - `var _ cloud.ExternalStorage = &s3Storage{}`
- Provider registration layer:
  - `pkg/cloud/impl_registry.go`
    - `RegisterExternalStorageProvider(...)`

### Pattern call

- Strong explicit contract/impl split.
- Uses **domain package + provider packages + registry**, not `ports/usecases` vocabulary.

---

## 3) Grafana

### Observed layout

- Domain contracts colocated in the domain package:
  - `pkg/services/dashboards/dashboard.go`
    - `DashboardService`, `Store`, other service interfaces
- Implementations separated by mechanism:
  - `pkg/services/dashboards/database/database.go`
    - `type dashboardStore struct`
    - `var _ dashboards.Store = (*dashboardStore)(nil)`
  - `pkg/services/dashboards/service/dashboard_service.go`
    - `type DashboardServiceImpl struct`
    - compile assertions for dashboard interfaces
- Similar pattern in auth/user modules:
  - `pkg/services/authn/authn.go` defines interface set in domain package
  - `pkg/services/user/user.go` interface + `pkg/services/user/userimpl/store.go` implementation

### Pattern call

- **Colocate contracts with domain package**, use explicit impl package names (`database`, `service`, `userimpl`).
- This is very close to Mattermost-style service/store layering.

---

## 4) Mattermost

### Observed layout

- Large central store contracts package:
  - `server/channels/store/store.go`
    - root `Store` plus many sub-interfaces (`TeamStore`, `ChannelStore`, `PostStore`, ...)
- SQL implementations in dedicated impl package:
  - `server/channels/store/sqlstore/store.go`
    - `type SqlStore struct`, constructor `New(...)`
  - `server/channels/store/sqlstore/channel_store.go`
    - concrete `SqlChannelStore`
- App layer depends on contracts, not sql concrete:
  - `server/channels/app/server.go`
    - `func (s *Server) Store() store.Store`

### Pattern call

- Very explicit contracts package + concrete mechanism package (`sqlstore`).
- Naming avoids conflict by using `store` vs `sqlstore`, not two near-identical `service` names.

---

## 5) HashiCorp (Consul / Vault / Nomad)

### Consul

- Many interfaces are local/consumer-side in subsystem packages:
  - `agent/grpc-external/services/resource/server.go`
    - `Registry`, `Backend`, `ACLResolver`, `TenancyBridge`
- Concrete server struct in same package (`type Server struct`) consuming those interfaces.

Pattern: **consumer-side/local interfaces**, often narrow and package-scoped.

### Vault

- Boundary contracts in SDK packages used by many implementations:
  - `sdk/logical/storage.go` -> `type Storage interface`
  - `sdk/physical/physical.go` -> `type Backend interface`, `HABackend`, etc.
- Concrete backend implementation separate:
  - `physical/raft/raft.go`
    - `func NewRaftBackend(...) (physical.Backend, error)`

Pattern: **shared boundary SDK contracts + pluggable backend implementations**.

### Nomad

- Plugin contracts in dedicated plugin packages:
  - `plugins/base/base.go` -> `BasePlugin`
  - `plugins/drivers/driver.go` -> `DriverPlugin` and related interfaces
- Concrete driver implementations elsewhere:
  - `drivers/rawexec/driver.go`
    - `type Driver struct`
    - `func NewRawExecDriver(...) drivers.DriverPlugin`
    - `var _ drivers.ExecTaskStreamingRawDriver = (*Driver)(nil)`

Pattern: **plugin interface packages + per-driver implementations**.

---

## 6) Caddy

### Observed layout

- Core extensibility contracts in central package:
  - `modules.go`
    - `type Module interface`
    - `RegisterModule(instance Module)`
    - lifecycle interfaces (`Provisioner`, `Validator`, `CleanerUpper`)
- Implementations live in module packages and self-register via init.

### Pattern call

- Central plugin contract package is explicit and successful for extension ecosystems.

---

## 7) Gitea / Forgejo

(Forgejo follows very similar lineage/patterns to Gitea in this area.)

### Observed layout (Gitea)

- Auth method contracts in service package:
  - `services/auth/interface.go`
    - `type Method interface`
- Concrete method implementations beside it (not in one global impl pkg):
  - `services/auth/basic.go`
    - `type Basic struct`
    - `var _ Method = &Basic{}`
- Config/source types in subpackages:
  - `services/auth/source/oauth2/source.go`
    - provider-specific `Source` type and registration

### Pattern call

- **Interface in domain/service package; concrete implementations in same package or nearby subpackages**.

---

## Cross-project synthesis

### Do they use dedicated interface packages?

- Sometimes, but usually **by subsystem boundary** (`rest`, `storage`, `sdk/physical`, `plugins/drivers`) rather than one global `interfaces` package.

### Do they colocate interfaces with implementations?

- Often interfaces are colocated with domain package and implementations in sibling mechanism packages (`database`, `sqlstore`, `impl`, provider dirs).

### Consumer-side interfaces?

- Yes, especially in Consul-like service packages and internal app layers.

### Package naming in practice

Common real names:
- `store`, `sqlstore`, `database`
- `service`, `serviceimpl`, `userimpl`
- `rest`, `storage`, `factory`
- `plugins/*`, `sdk/*`, provider names (`amazon`, `nodelocal`)

Rare as primary package names in these repos:
- `ports`
- `usecases`
- `contracts` (used occasionally in comments/docs, less as dominant package root)

### How they separate “what app does” from “external systems”

- Contracts in domain/boundary package.
- External mechanism packages for adapters/providers.
- Wiring/registration constructors return interfaces.
- Frequent compile-time assertions (`var _ Interface = (*Impl)(nil)`).

### Architecture vocabulary in code

- Most repos do **not** strongly label packages as `clean`, `hexagonal`, `ddd`.
- They apply patterns pragmatically without strict naming vocabulary.

---

## Recommendation for your layout decision

Current:
- `domain/services/billing` (interfaces)
- `service/billing` (implementations)

Primary issue is naming collision (`service` vs `services`), not architecture purity.

### Recommended direction

Use **domain-specific contract package names that do not overlap with implementation package names**.

Practical options ranked:

1. `domain/billing` (contracts + domain types) + `service/billing` (impl)
2. `domain/contracts/billing` + `service/billing`
3. Keep `domain/services/billing` only if you rename impl side to `billingimpl`/`adapter/billing`/`billingstore`

I would avoid `domain/usecases` unless you are committing to full clean-architecture semantics repo-wide.
I would only choose `domain/ports` if the team already uses hexagonal vocabulary consistently.

Given your current confusion, the most pragmatic path is:
- **rename `domain/services` -> `domain/contracts` (or `domain/<domain>`),**
- keep implementation packages mechanism-specific (`service`, `database`, `sqlstore`, provider dirs),
- add compile assertions in impls (`var _ billing.Contract = (*BillingService)(nil)`) and brief package README comments.

This aligns best with what these production repos actually do: clear boundary names, mechanism-specific impl packages, minimal theory-heavy naming.

---

## Source links inspected

- Kubernetes:
  - https://github.com/kubernetes/kubernetes/blob/master/staging/src/k8s.io/apiserver/pkg/registry/rest/rest.go
  - https://github.com/kubernetes/kubernetes/blob/master/staging/src/k8s.io/apiserver/pkg/registry/generic/registry/store.go
  - https://github.com/kubernetes/kubernetes/blob/master/staging/src/k8s.io/apiserver/pkg/server/storage/storage_factory.go
- CockroachDB:
  - https://github.com/cockroachdb/cockroach/blob/master/pkg/cloud/external_storage.go
  - https://github.com/cockroachdb/cockroach/blob/master/pkg/cloud/impl_registry.go
  - https://github.com/cockroachdb/cockroach/blob/master/pkg/cloud/nodelocal/nodelocal_storage.go
  - https://github.com/cockroachdb/cockroach/blob/master/pkg/cloud/amazon/s3_storage.go
- Grafana:
  - https://github.com/grafana/grafana/blob/main/pkg/services/dashboards/dashboard.go
  - https://github.com/grafana/grafana/blob/main/pkg/services/dashboards/database/database.go
  - https://github.com/grafana/grafana/blob/main/pkg/services/dashboards/service/dashboard_service.go
  - https://github.com/grafana/grafana/blob/main/pkg/services/authn/authn.go
  - https://github.com/grafana/grafana/blob/main/pkg/services/user/user.go
- Mattermost:
  - https://github.com/mattermost/mattermost/blob/master/server/channels/store/store.go
  - https://github.com/mattermost/mattermost/blob/master/server/channels/store/sqlstore/store.go
  - https://github.com/mattermost/mattermost/blob/master/server/channels/app/server.go
- Consul:
  - https://github.com/hashicorp/consul/blob/main/agent/grpc-external/services/resource/server.go
- Vault:
  - https://github.com/hashicorp/vault/blob/main/sdk/logical/storage.go
  - https://github.com/hashicorp/vault/blob/main/sdk/physical/physical.go
  - https://github.com/hashicorp/vault/blob/main/physical/raft/raft.go
- Nomad:
  - https://github.com/hashicorp/nomad/blob/main/plugins/base/base.go
  - https://github.com/hashicorp/nomad/blob/main/plugins/drivers/driver.go
  - https://github.com/hashicorp/nomad/blob/main/drivers/rawexec/driver.go
- Caddy:
  - https://github.com/caddyserver/caddy/blob/master/modules.go
- Gitea:
  - https://github.com/go-gitea/gitea/blob/main/services/auth/interface.go
  - https://github.com/go-gitea/gitea/blob/main/services/auth/basic.go
  - https://github.com/go-gitea/gitea/blob/main/services/auth/source/oauth2/source.go
