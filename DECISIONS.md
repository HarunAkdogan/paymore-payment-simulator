# Technical decisions

1. **NestJS over bare Express:** consistent modules, dependency injection, guards, validation integration and testability; NestJS uses Express adapter by default.
2. **MongoDB/Mongoose:** chosen to match the document data model and requested MongoDB practice.
3. **Integer minor units:** money is stored as integer minor units to avoid binary floating-point rounding.
4. **Provider abstraction:** service depends on a provider-shaped API; the mock implementation can later be replaced by a real adapter.
5. **UNKNOWN status:** a timeout does not prove failure. Persist uncertainty and inquire using the merchant reference.
6. **Redis fail policy:** rate limit fails open for availability; payment creation fails closed if idempotency cannot be reserved.
7. **Refund conditional update:** database condition checks the previously observed refunded amount and caps cumulative refund at captured amount.
8. **Demo scope:** mock provider state is in-memory and no real payment credentials/card data are handled.
