import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import Case from './case.jsx'
import AdminCreateHome from './pages/AdminCreateHome.jsx'
import AdminHome from './pages/AdminHome.jsx'
import AdminTemplatePicker from './pages/AdminTemplatePicker.jsx'
import Home from './pages/Home.jsx'
import StudentHome from './pages/StudentHome.jsx'

// Client-side guard: bounce anyone without an admin token back to the home
// screen. This is UX polish only — the API is the real gate (admin endpoints
// return 401 without a valid token).
function RequireAdmin() {
    const hasAdminToken = Boolean(sessionStorage.getItem('caseLabAdminToken'))
    return hasAdminToken ? <Outlet /> : <Navigate to="/" replace />
}

function App() {
    return (
        <Routes>
            <Route path="/" element={<Home />} />
            <Route element={<RequireAdmin />}>
                <Route path="/admin" element={<AdminHome />} />
                <Route path="/admin/new" element={<AdminCreateHome />} />
                <Route path="/admin/new/scratch" element={<Case />} />
                <Route path="/admin/new/template" element={<AdminTemplatePicker />} />
                <Route path="/admin/new/form" element={<Case />} />
                <Route path="/admin/edit" element={<AdminTemplatePicker mode="edit" />} />
                <Route path="/admin/edit/form" element={<Case />} />
            </Route>
            <Route path="/student" element={<StudentHome />} />
            <Route path="/newCase" element={<Navigate to="/admin/new/scratch" replace />} />
        </Routes>
    )
}

export default App
