.PHONY: bootstrap dev lint format typecheck test check

bootstrap:
	pnpm run bootstrap

dev:
	pnpm run dev

lint:
	pnpm run lint

format:
	pnpm run format:write

typecheck:
	pnpm run typecheck

test:
	pnpm run test

check:
	pnpm run check
