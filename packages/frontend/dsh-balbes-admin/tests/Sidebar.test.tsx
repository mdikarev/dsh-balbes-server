import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Sidebar from "../src/components/Sidebar";

describe("Sidebar", () => {
  it("рендерит группы навигации и помечает «Тестовая страница» активной", () => {
    render(<Sidebar active="test" onNavigate={() => {}} />);

    // Group labels from the mockup.
    expect(screen.getByText("Работа")).toBeTruthy();
    expect(screen.getByText("Управление")).toBeTruthy();
    expect(screen.getByText("Система")).toBeTruthy();

    // «Тестовая страница» is the active item.
    const activeItem = screen.getByText("Тестовая страница");
    expect(activeItem.className).toContain("active");

    // «Модели» replaced the ghost «Ключи» and is a live button without the
    // «скоро» pill; remaining ghost items are grayed out and carry the pill.
    const models = screen.getByRole("button", { name: "Модели" });
    expect(models.className).not.toContain("ghost");
    expect(models.textContent).not.toContain("скоро");

    for (const label of ["Скиллы", "Агенты", "Команды", "Настройки"]) {
      const item = screen.getByText(label);
      expect(item.className).toContain("ghost");
    }
    expect(screen.getAllByText("скоро")).toHaveLength(4);
  });

  it("«Модели» is a live item that fires onNavigate with its id", () => {
    const onNavigate = vi.fn();
    render(<Sidebar active="test" onNavigate={onNavigate} />);

    // The ghost «Ключи» item is gone.
    expect(screen.queryByText("Ключи")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Модели" }));
    expect(onNavigate).toHaveBeenCalledWith("models");
  });

  it("fires onNavigate for live items", () => {
    const onNavigate = vi.fn();
    render(<Sidebar active="test" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText("Проекты"));
    expect(onNavigate).toHaveBeenCalledWith("workspaces");
  });

  it("«Telegram» sits next to «Модели» as a live item without the «скоро» pill", () => {
    const onNavigate = vi.fn();
    render(<Sidebar active="models" onNavigate={onNavigate} />);

    const models = screen.getByRole("button", { name: "Модели" });
    const telegram = screen.getByRole("button", { name: "Telegram" });
    expect(telegram.className).not.toContain("ghost");
    expect(telegram.textContent).not.toContain("скоро");
    expect(models.compareDocumentPosition(telegram) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    fireEvent.click(telegram);
    expect(onNavigate).toHaveBeenCalledWith("telegram");
  });

  it("marks «Telegram» active without turning the ghost items live", () => {
    render(<Sidebar active="telegram" onNavigate={() => {}} />);
    const telegram = screen.getByRole("button", { name: "Telegram" });
    expect(telegram.className).toContain("active");
    expect(telegram.getAttribute("aria-current")).toBe("page");
    expect(screen.getAllByText("скоро")).toHaveLength(4);
  });
});
