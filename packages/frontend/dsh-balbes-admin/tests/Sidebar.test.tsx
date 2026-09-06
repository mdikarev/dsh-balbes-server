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

    // Ghost items are present, grayed out and carry the «скоро» pill.
    for (const label of ["Ключи", "Скиллы", "Агенты", "Команды", "Настройки"]) {
      const item = screen.getByText(label);
      expect(item.className).toContain("ghost");
    }
    expect(screen.getAllByText("скоро")).toHaveLength(5);
  });

  it("fires onNavigate for live items", () => {
    const onNavigate = vi.fn();
    render(<Sidebar active="test" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText("Проекты"));
    expect(onNavigate).toHaveBeenCalledWith("workspaces");
  });
});
